import { createInterface } from 'node:readline'

/** Flush a rotated credential before a response can settle a controller turn. */
export async function forwardProviderOutput(source, destination, flush) {
  const lines = createInterface({ input: source, crlfDelay: Infinity })
  for await (const line of lines) {
    const message = JSON.parse(line)
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) await flush()
    destination.write(`${line}\n`)
  }
}
