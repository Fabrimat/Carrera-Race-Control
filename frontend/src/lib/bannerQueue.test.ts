import { describe, expect, it } from 'vitest'
import {
  advance,
  dismiss,
  emptyQueue,
  endOf,
  enqueue,
  EXIT_MS,
  isExiting,
  MAX_QUEUE,
  MAX_WAIT_MS,
  nextWake,
  priorityOf,
  type Banner,
  type BannerKind,
} from './bannerQueue'

const mk = (id: string, kind: BannerKind = 'overtake', durationMs = 3000): Banner => ({
  id,
  kind,
  priority: priorityOf(kind),
  durationMs,
  layout: 'lower',
  title: id,
})

describe('banner queue', () => {
  it('shows the first banner immediately and queues the next without overlap', () => {
    let q = enqueue(emptyQueue, mk('a'), 0)
    expect(q.active?.banner.id).toBe('a')
    q = enqueue(q, mk('b'), 100)
    expect(q.active?.banner.id).toBe('a')
    expect(q.queue).toHaveLength(1)
  })

  it('only starts the next banner after the active one finished its exit', () => {
    let q = enqueue(emptyQueue, mk('a'), 0)
    q = enqueue(q, mk('b'), 10)
    q = advance(q, 3000)
    expect(isExiting(q.active!, 3000)).toBe(true)
    expect(q.active?.banner.id).toBe('a')
    q = advance(q, 3000 + EXIT_MS)
    expect(q.active?.banner.id).toBe('b')
    expect(q.active?.startedAt).toBe(3000 + EXIT_MS)
  })

  it('plays higher priority first, FIFO within the same priority', () => {
    let q = enqueue(emptyQueue, mk('first'), 0)
    q = enqueue(q, mk('pit1', 'pit_in'), 1)
    q = enqueue(q, mk('over', 'overtake'), 2)
    q = enqueue(q, mk('fast', 'fastest_lap'), 3)
    q = enqueue(q, mk('pit2', 'pit_out'), 4)
    const order: string[] = []
    while (q.active) {
      order.push(q.active.banner.id)
      q = advance(q, endOf(q.active))
    }
    expect(order).toEqual(['first', 'fast', 'over', 'pit1', 'pit2'])
  })

  it('ignores duplicates of the active or queued banner', () => {
    let q = enqueue(emptyQueue, mk('a'), 0)
    q = enqueue(q, mk('a'), 5)
    q = enqueue(q, mk('b'), 6)
    q = enqueue(q, mk('b'), 7)
    expect(q.queue).toHaveLength(1)
  })

  it('drops banners that waited too long', () => {
    let q = enqueue(emptyQueue, mk('a', 'overtake', 60000), 0)
    q = enqueue(q, mk('stale'), 1)
    q = advance(q, MAX_WAIT_MS + 5)
    expect(q.queue).toHaveLength(0)
  })

  it('bounds the queue, dropping the least important', () => {
    let q = enqueue(emptyQueue, mk('active', 'overtake', 60000), 0)
    for (let i = 0; i < MAX_QUEUE + 3; i++) q = enqueue(q, mk(`p${i}`, 'pit_in'), 1)
    q = enqueue(q, mk('record', 'track_record'), 2)
    expect(q.queue.length).toBeLessThanOrEqual(MAX_QUEUE)
    expect(q.queue.some((e) => e.banner.id === 'record')).toBe(true)
  })

  it('the chequered flag wipes lower priorities still waiting but waits for the active banner', () => {
    let q = enqueue(emptyQueue, mk('a', 'overtake', 60000), 0)
    q = enqueue(q, mk('b', 'pit_in'), 1)
    q = enqueue(q, mk('end', 'chequered', Infinity), 2)
    expect(q.active?.banner.id).toBe('a')
    expect(q.queue.map((e) => e.banner.id)).toEqual(['end'])
  })

  it('sticky banners stay until dismissed, then exit and free the stage', () => {
    let q = enqueue(emptyQueue, mk('end', 'chequered', Infinity), 0)
    q = advance(q, 600000)
    expect(q.active?.banner.id).toBe('end')
    expect(nextWake(q, 600000)).toBeNull()
    q = dismiss(q, 'end', 700000)
    expect(isExiting(q.active!, 700000)).toBe(true)
    expect(nextWake(q, 700000)).toBe(EXIT_MS)
    q = advance(q, 700000 + EXIT_MS)
    expect(q.active).toBeNull()
  })

  it('nextWake points at the exit start, then at the end', () => {
    const q = enqueue(emptyQueue, mk('a'), 0)
    expect(nextWake(q, 1000)).toBe(2000)
    expect(nextWake(q, 3100)).toBe(EXIT_MS - 100)
    expect(nextWake(emptyQueue, 0)).toBeNull()
  })
})
