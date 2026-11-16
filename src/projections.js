/**
 * Client-visible review projections: the latest `workspace/changes` event and
 * the review-unit settings. Both are derived from the session log/config, never
 * from plugin-private storage.
 * @module dsh-review-gate/projections
 */

import { isPlainObject } from './util.js'

export const CHANGES_PROJECTION_KEY = 'review-gate/changes'
export const META_PROJECTION_KEY = 'review-gate/meta'

/** @typedef {{ seq: number, turn: number }} ChangesState */

/** @param {unknown} value @returns {ChangesState} */
function parseChanges(value) {
  if (!isPlainObject(value)) throw new TypeError('review-gate changes state must be an object')
  if (!Number.isSafeInteger(value.seq) || value.seq < 0) throw new TypeError('review-gate changes state.seq must be a non-negative integer')
  if (!Number.isSafeInteger(value.turn) || value.turn < 0) throw new TypeError('review-gate changes state.turn must be a non-negative integer')
  return { seq: value.seq, turn: value.turn }
}

export const changesStateSchema = { parse: parseChanges }

/** @param {unknown} value */
function parseReviewMeta(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.maxUnits)) {
    throw new TypeError('review-gate meta must carry maxUnits')
  }
  if (!Array.isArray(value.entryPatterns) || value.entryPatterns.some(pattern => typeof pattern !== 'string')) {
    throw new TypeError('review-gate meta.entryPatterns must be string[]')
  }
  return { maxUnits: value.maxUnits, entryPatterns: [...value.entryPatterns] }
}

export const reviewMetaSchema = { parse: parseReviewMeta }

/**
 * Register the client-visible review projections.
 * @param {any} ctx
 * @param {{ review: { maxUnits: number, entryPatterns: string[] } }} config
 * @returns {Promise<{ changesHandle?: any, metaHandle?: any }>}
 */
export async function registerReviewProjections(ctx, config) {
  const registry = ctx.get?.('sessionProjections')
  if (registry === undefined || typeof registry.register !== 'function') return {}
  const metaState = Object.freeze({
    maxUnits: config.review.maxUnits,
    entryPatterns: Object.freeze([...config.review.entryPatterns]),
  })
  let changesHandle
  try {
    changesHandle = await registry.register({
      key: CHANGES_PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: changesStateSchema,
      init: () => ({ seq: 0, turn: 0 }),
      apply: (state, event) => {
        if (event?.type !== 'workspace/changes') return state
        const turn = event.data?.turn
        if (!Number.isSafeInteger(turn) || turn < 1) return state
        if (state.seq === event.seq && state.turn === turn) return state
        return { seq: event.seq, turn }
      },
      wire: {
        viewSchema: changesStateSchema,
        view: state => state,
      },
    })
  } catch (error) {
    ctx.logger?.warn?.('[review-gate] changes projection unavailable:', error)
    return {}
  }
  try {
    const metaHandle = await registry.register({
      key: META_PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: reviewMetaSchema,
      init: () => metaState,
      apply: state => state,
      wire: {
        viewSchema: reviewMetaSchema,
        view: state => state,
      },
    })
    return { changesHandle, metaHandle }
  } catch (error) {
    ctx.logger?.warn?.('[review-gate] review meta projection unavailable:', error)
    try {
      await changesHandle.dispose()
    } catch {
      // The fiber can still release the first registration.
    }
    return {}
  }
}
