import * as fs from 'fs'

export async function exists(p: string) {
  try {
    return await fs.promises.stat(p)
  } catch (e) {
    return
  }
}
