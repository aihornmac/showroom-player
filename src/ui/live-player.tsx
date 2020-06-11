import * as React from 'react'
import styled from 'styled-components'
import { observable, computed, action, createAtom } from 'mobx'
import { useObserver } from 'mobx-react'
import { Base64 } from 'js-base64'
import { client, subscribeRoomCurrentLive } from '../modules/showroom-live-stream/client'
import { call } from '../utils/js'
import { useBoxedValue } from '../utils/react-hooks'
import { LivePlayer as LivePlayerModule } from '../modules/showroom-live-stream/player'
import { useHotkeys } from 'react-hotkeys-hook'
import { useLocalStore } from '../utils/mobx-react'
import { Disposers } from '../utils/disposers'
import { SVGPlayPause } from './svg-play-pause'
import { TakeLastStream } from '../utils/stream'
import { ipc } from '../ipc/client'

export const LivePlayer = React.memo((props: {
  roomId: number
  liveId: number
  online: boolean
}) => {
  const { roomId, liveId, online } = props

  return (
    <StreamPlayer
      // do not resue stream player
      key={`${roomId} ${liveId} ${online ? 'online' : 'offline'}`}
      roomId={roomId}
      liveId={liveId}
      online={online}
    />
  )
})

LivePlayer.displayName = 'LivePlayer'

class State {
  constructor(readonly props: {
    readonly livePlayer: LivePlayerModule
    readonly videoRef: React.MutableRefObject<React.RefObject<HTMLVideoElement>>
  }) {
    this._disposers = new Disposers()
    const { livePlayer } = props

    this._disposers.add(
      'sync duration',
      livePlayer.events.subscribe('update duration', () => {
        this._duration.update()
      })
    )

    this._disposers.add(
      'sync partial start time',
      livePlayer.events.subscribe('update partialStartTime', () => {
        this._partialStartTime.update()
      })
    )

    this._disposers.add(
      'sync playing',
      livePlayer.events.subscribe('update isPlaying', () => {
        this._isPlaying.update()
      })
    )
  }

  private _disposers: Disposers

  private _duration = createAtomGetter('partialStartTime', () => {
    return this.props.livePlayer.duration
  })

  private _partialStartTime = createAtomGetter('partialStartTime', () => {
    return this.props.livePlayer.partStartTime
  })

  private _isPlaying = createAtomGetter('isPlaying', () => {
    return this.props.livePlayer.isPlaying
  })

  @observable.ref
  isHovering = false

  @observable.ref
  private _videoCurrentTime = 0

  get video() {
    const video = this.props.videoRef.current.current
    if (!video) throw new Error(`video is not set`)
    return video
  }

  get currentTime() {
    return this._partialStartTime.get() + this._videoCurrentTime
  }

  get duration() {
    return this._duration.get()
  }

  get isPlaying() {
    return this._isPlaying.get()
  }

  play() {
    return this.props.livePlayer.play()
  }

  pause() {
    return this.props.livePlayer.pause()
  }

  @action
  offsetCurrentTime(seconds: number) {
    return this.setCurrentTIme(this.currentTime + seconds)
  }

  @action
  setCurrentTIme(seconds: number) {
    const duration = this._duration.get()
    const { livePlayer } = this.props
    const currentTime = Math.max(0, Math.min(seconds, duration))
    return livePlayer.seek(currentTime)
  }

  @action
  setPercent(percent: number) {
    return this.setCurrentTIme(percent * this._duration.get())
  }

  @action
  updateVideoCurrentTime(seconds: number) {
    this._videoCurrentTime = seconds
  }

  destroy() {
    this._disposers.clear()
  }
}

const StateContext = React.createContext(undefined as unknown as State)

const StreamPlayer = React.memo((props: {
  roomId: number
  liveId: number
  online: boolean
}) => {
  const { roomId, liveId, online } = props
  const livePlayer = React.useMemo(() => {
    return new LivePlayerModule(
      () => videoRef.current.current,
      roomId,
      liveId,
    )
  }, [roomId, liveId])
  const videoRef = useBoxedValue(React.createRef<HTMLVideoElement>())
  const state = useLocalStore(p => new State(p), { livePlayer, videoRef })
  const updateChunkMetaStreamRef = useBoxedValue(React.useState(() => new TakeLastStream<void>())[0])

  console.log({ livePlayer })

  React.useEffect(() => () => { state.destroy() }, [])

  React.useEffect(() => () => { livePlayer.destroy() }, [roomId, liveId])

  React.useEffect(() => {
    if (!online) return
    return subscribeRoomCurrentLive(roomId, event => {
      if (event.kind === 'recorder') {
        // console.log(event)
        const { data } = event
        if (data.kind === 'hls') {
          const hlsData = data.data
          if (hlsData.kind === 'finish downloading chunk') {
            updateChunkMetaStreamRef.current.write()
          }
        }
      }
    })
  }, [roomId, online])

  // loop chunks meta
  React.useEffect(() => {
    let destroyed = false
    call(async () => {
      const chunksInfo = await client.async('getChunksMeta')(roomId, liveId)
      console.log({ chunksInfo })
      if (destroyed) return

      livePlayer.addChunkMeta(chunksInfo.values())
      let loadedChunks = livePlayer.countChunks()

      await livePlayer.seek(online ? livePlayer.validEndTimepoint : livePlayer.validStartTimepoint)
      if (destroyed) return

      await livePlayer.play()
      if (destroyed) return

      if (!online) return

      while (true) {
        const ret = await updateChunkMetaStreamRef.current.read()
        if (destroyed) return
        if (ret.done) return

        const chunksInfo = await client.async('getChunksMeta')(roomId, liveId)
        if (destroyed) return

        livePlayer.addChunkMeta(chunksInfo.values())
        const prevLoadedChunks = loadedChunks
        loadedChunks = livePlayer.countChunks()
        if (!prevLoadedChunks) {
          await livePlayer.seek(livePlayer.validEndTimepoint)
        }
      }
    })
    return () => { destroyed = true }
  }, [roomId, liveId, online])

  const onTimeUpdate = React.useMemo(() => (e: React.SyntheticEvent<HTMLVideoElement>) => {
    state.updateVideoCurrentTime(e.currentTarget.currentTime)
  }, [])

  return (
    <StateContext.Provider value={state}>
      <StreamPlayerWrapper>
        <video
          ref={videoRef.current}
          src={livePlayer.url}
          onTimeUpdate={onTimeUpdate}
          style={{ width: '100%', height: '100%' }}
        />
        <OperationContainer />
      </StreamPlayerWrapper>
    </StateContext.Provider>
  )
})

StreamPlayer.displayName = 'StreamPlayer'

const StreamPlayerWrapper = React.memo((props: { children?: React.ReactNode }) => {
  const state = React.useContext(StateContext)

  const timerRef = React.useRef<ReturnType<typeof setTimeout>>()

  useHotkeys('esc', () => {
    ipc.sync('fullscreen')(false)
  })

  useHotkeys('left', () => {
    state.offsetCurrentTime(-5)
  })

  useHotkeys('right', () => {
    state.offsetCurrentTime(5)
  })

  useHotkeys('shift+left', () => {
    state.offsetCurrentTime(-1)
  })

  useHotkeys('shift+right', () => {
    state.offsetCurrentTime(1)
  })

  useHotkeys('down', () => {
    state.offsetCurrentTime(-10)
  })

  useHotkeys('up', () => {
    state.offsetCurrentTime(10)
  })

  useHotkeys('shift+down', () => {
    state.offsetCurrentTime(-60)
  })

  useHotkeys('shift+up', () => {
    state.offsetCurrentTime(60)
  })

  useHotkeys('space', () => {
    if (state.isPlaying) {
      state.props.livePlayer.pause()
    } else {
      state.props.livePlayer.play()
    }
  })

  React.useEffect(() => () => {
    const timer = timerRef.current
    if (timer) clearTimeout(timer)
  }, [])

  const onHoverWrapper = React.useMemo(() => () => {
    const timer = timerRef.current
    if (timer) clearTimeout(timer)
    timerRef.current = setTimeout(() => {
      state.isHovering = false
    }, 1000)
    state.isHovering = true
  }, [])

  const onDoubleClick = React.useMemo(() => () => {
    ipc.sync('toggleFullscreen')()
  }, [])

  return useObserver(() => {
    return (
      <Wrapper
        className={state.isHovering ? 'hovering' : ''}
        onMouseMove={onHoverWrapper}
        onDoubleClick={onDoubleClick}
      >
        {props.children}
      </Wrapper>
    )
  })
})

StreamPlayerWrapper.displayName = 'StreamPlayerWrapper'

const OperationContainer = React.memo(() => {
  const state = React.useContext(StateContext)
  return useObserver(() => {
    return (
      <OperationBar>
        <Button onClick={() => state.isPlaying ? state.pause() : state.play()}>
          <SquareContainer>
            <SVGPlayPause icon={state.isPlaying ? 'pause' : 'play'} />
          </SquareContainer>
        </Button>
        <CurrentTimeContainer />
        <ProgressBarContainer />
        <RestTimeContainer />
      </OperationBar>
    )
  })
})

OperationContainer.displayName = 'OperationContainer'

const CurrentTimeContainer = React.memo(() => {
  const state = React.useContext(StateContext)

  const truncatedTime = React.useMemo(() => computed(() => state.currentTime), [])

  return useObserver(() => {
    return (
      <TimeWrapper>
        {formatDuration(truncatedTime.get())}
      </TimeWrapper>
    )
  })
})

CurrentTimeContainer.displayName = 'CurrentTimeContainer'

const RestTimeContainer = React.memo(() => {
  const state = React.useContext(StateContext)

  const truncatedTime = React.useMemo(() => computed(() => Math.max(0, state.duration - state.currentTime)), [])

  return useObserver(() => {
    return (
      <TimeWrapper>
        -{formatDuration(truncatedTime.get())}
      </TimeWrapper>
    )
  })
})

RestTimeContainer.displayName = 'RestTimeContainer'

const ProgressBarContainer = React.memo(() => {
  const state = React.useContext(StateContext)
  const wrapperRef = useBoxedValue(React.createRef<HTMLDivElement>())

  const trigger = React.useMemo(() => (e: HTMLElement, clientX: number) => {
    const { x, width } = e.getBoundingClientRect()
    if (!width) return
    state.setPercent((clientX - x) / width)
  }, [])

  const onMouseDown = React.useMemo(() => (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    e.stopPropagation()
    trigger(e.currentTarget, e.clientX)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  const onMouseMove = React.useMemo(() => (e: MouseEvent) => {
    const wrapper = wrapperRef.current.current
    if (!wrapper) return
    trigger(wrapper, e.clientX)
  }, [])

  const onMouseUp = React.useMemo(() => () => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }, [])

  return useObserver(() => {
    const { duration, currentTime } = state
    const percent = Math.min(1, duration ? currentTime / duration : 0)
    return (
      <ProgressBarWrapper
        ref={wrapperRef.current}
        onMouseDown={onMouseDown}
      >
        <ProgressBar
          style={{ width: `${percent * 100}%` }}
        />
      </ProgressBarWrapper>
    )
  })
})

ProgressBarContainer.displayName = 'ProgressBarContainer'

const SquareContainer = (props: { children?: React.ReactNode }) => {
  return (
    <>
      <SquareHolder />
      <SquareWrapper>
        {props.children}
      </SquareWrapper>
    </>
  )
}

const squareHolder = `<svg width="1" height="1" viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"></svg>`

const squareHolderBase64 = `data:image/svg+xml;base64,${Base64.encode(squareHolder)}`

const SquareHolder = React.memo(() => {
  return <img src={squareHolderBase64} style={{ height: '100%' }} />
}, () => true)

SquareHolder.displayName = 'SquareHolder'

function formatDuration(duration: number) {
  const seconds = duration % 60
  duration = (duration - seconds) / 60

  const minutes = duration % 60
  duration = (duration - minutes) / 60

  const hours = duration

  return `${padString(hours, '00')}:${padString(minutes, '00')}:${padString(Math.floor(seconds), '00')}`
}

function padString(src: string | number, pad: string) {
  const str = String(src)
  return (pad + src).slice(-Math.max(str.length, pad.length))
}

function createAtomGetter<T>(name: string, get: () => T) {
  const atom = createAtom(name)
  return {
    update: () => { atom.reportChanged() },
    get: () => (atom.reportObserved(), get()),
  }
}

const Wrapper = styled.div`
  position: fixed;
  width: 100%;
  height: 100%;
  -webkit-app-region: drag;
  background: black;
`

const OperationBar = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 25%;
  height: 40px;
  opacity: 0;
  background: rgba(0, 0, 0, .6);
  -webkit-app-region: no-drag;
  user-select: none;
  display: flex;

  ${Wrapper}.hovering &, &:hover {
    opacity: 1;
  }
`

const TimeWrapper = styled.div`
  flex: 0 0 auto;
  min-width: 6em;
  font-size: 20px;
  font-family: Arial;
  color: #fff;
  display: flex;
  justify-content: center;
  align-items: center;
`

const ProgressBarWrapper = styled.div`
  flex: 1 1 0;
  position: relative;
  margin: 4px 0;
  background: rgba(255, 255, 255, .2);
`

const ProgressBar = styled.div`
  width: 0;
  height: 100%;
  background: #fff;
`

const Button = styled.div`
  position: relative;
  height: 100%;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, .2);
  }
`

const SquareWrapper = styled.div`
  position: absolute;
  width: 100%;
  height: 100;
  left: 0;
  top: 0;
`