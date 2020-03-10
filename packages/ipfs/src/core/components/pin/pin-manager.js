/* eslint max-nested-callbacks: ["error", 8] */
'use strict'

const CID = require('cids')
const errCode = require('err-code')
const dagCborLinks = require('dag-cbor-links')
const debug = require('debug')
// const parallelBatch = require('it-parallel-batch')
const first = require('it-first')
const all = require('it-all')
const cbor = require('cbor')

// arbitrary limit to the number of concurrent dag operations
// const WALK_DAG_CONCURRENCY_LIMIT = 300
// const IS_PINNED_WITH_TYPE_CONCURRENCY_LIMIT = 300
// const PIN_DS_KEY = new Key('/local/pins')

function invalidPinTypeErr (type) {
  const errMsg = `Invalid type '${type}', must be one of {direct, indirect, recursive, all}`
  return errCode(new Error(errMsg), 'ERR_INVALID_PIN_TYPE')
}

function toKey (cid) {
  return '/' + cid.multihash.toString('base64')
}

const PinTypes = {
  direct: 'direct',
  recursive: 'recursive',
  indirect: 'indirect',
  all: 'all'
}

class PinManager {
  constructor (repo, dag) {
    this.repo = repo
    this.dag = dag
    this.log = debug('ipfs:pin')
    this.directPins = new Set()
    this.recursivePins = new Set()
  }

  async * _walkDag (cid, { preload = false }) {
    const { value: node } = await this.dag.get(cid, { preload })

    if (cid.codec === 'dag-pb') {
      for (const link of node.Links) {
        yield link.Hash
        yield * this._walkDag(link.Hash, { preload })
      }
    } else if (cid.codec === 'dag-cbor') {
      for (const [_, childCid] of dagCborLinks(node)) { // eslint-disable-line no-unused-vars
        yield childCid
        yield * this._walkDag(childCid, { preload })
      }
    }
  }

  async pinDirectly (cid, options = {}) {
    await this.dag.get(cid, options)

    return this.repo.pins.put(toKey(cid), cbor.encode({
      cid: cid.buffer,
      type: PinTypes.direct,
      comments: options.comments
    }))
  }

  async unpin (cid) { // eslint-disable-line require-await
    return this.repo.pins.delete(toKey(cid))
  }

  async pinRecursively (cid, options = {}) {
    await this.fetchCompleteDag(cid, options)

    await this.repo.pins.put(toKey(cid), cbor.encode({
      cid: cid.buffer,
      type: PinTypes.recursive,
      comments: options.comments
    }))
  }

  async * directKeys () {
    for await (const entry of this.repo.pins.query({
      filters: [(entry) => {
        const pin = cbor.decode(entry.value)

        return pin.type === PinTypes.direct
      }]
    })) {
      const pin = cbor.decode(entry.value)

      yield {
        cid: new CID(pin.cid),
        comments: pin.comments
      }
    }
  }

  async * recursiveKeys () {
    for await (const entry of this.repo.pins.query({
      filters: [(entry) => {
        const pin = cbor.decode(entry.value)

        return pin.type === PinTypes.recursive
      }]
    })) {
      const pin = cbor.decode(entry.value)

      yield {
        cid: new CID(pin.cid),
        comments: pin.comments
      }
    }
  }

  async * indirectKeys ({ preload }) {
    for await (const { cid } of this.recursiveKeys()) {
      for await (const childCid of this._walkDag(cid, { preload })) {
        // recursive pins override indirect pins
        const types = [
          PinTypes.recursive
        ]

        const result = await this.isPinnedWithType(childCid, types)

        if (result.pinned) {
          continue
        }

        yield childCid
      }
    }
  }

  async isPinnedWithType (cid, types) {
    if (!Array.isArray(types)) {
      types = [types]
    }

    const all = types.includes(PinTypes.all)
    const direct = types.includes(PinTypes.direct)
    const recursive = types.includes(PinTypes.recursive)
    const indirect = types.includes(PinTypes.indirect)

    if (recursive || direct || all) {
      const result = await first(this.repo.pins.query({
        prefix: toKey(cid),
        filters: [entry => {
          if (all) {
            return true
          }

          const pin = cbor.decode(entry.value)

          return types.includes(pin.type)
        }],
        limit: 1
      }))

      if (result) {
        const pin = cbor.decode(result.value)

        return {
          cid,
          pinned: true,
          reason: pin.type,
          comments: pin.comments
        }
      }
    }

    const self = this

    async function * findChild (key, source) {
      for await (const { cid: parentCid } of source) {
        for await (const childCid of self._walkDag(parentCid, { preload: false })) {
          if (childCid.equals(key)) {
            yield parentCid
            return
          }
        }
      }
    }

    if (all || indirect) {
      // indirect (default)
      // check each recursive key to see if multihash is under it

      const parentCid = await first(findChild(cid, this.recursiveKeys()))

      if (parentCid) {
        return {
          cid,
          pinned: true,
          reason: PinTypes.indirect,
          parent: parentCid
        }
      }
    }

    return {
      cid,
      pinned: false
    }
  }

  async fetchCompleteDag (cid, options) {
    await all(this._walkDag(cid, { preload: options.preload }))
  }

  // Throws an error if the pin type is invalid
  static checkPinType (type) {
    if (typeof type !== 'string' || !Object.keys(PinTypes).includes(type)) {
      throw invalidPinTypeErr(type)
    }
  }
}

PinManager.PinTypes = PinTypes

module.exports = PinManager
