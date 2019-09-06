'use strict'

import secp256k1 from 'secp256k1'
import CryptoJS from 'crypto-js'
import cryptoRandomString from 'crypto-random-string'
import EventEmitter from 'events'
import Ajv from 'ajv'
import cookieStorage from './cookieStorage'
import createDebug from 'debug'
import Bottleneck from 'bottleneck'

import stringify from 'json-stable-stringify'

const debug = createDebug('messaging:')

const PROMPT_MESSAGE = 'I am ready to start messaging on Origin.'
const PROMPT_PUB_KEY = 'My public messaging key is: '
const MESSAGING_KEY = 'MK_'
const MESSAGING_PHRASE = 'MP_'
const PUB_MESSAGING_SIG = 'PMS_'
const PUB_MESSAGING = 'KEY_'
const UNREAD_STATUS = 'unread'
const READ_STATUS = 'read'
const COULD_NOT_DECRYPT = 'Could not decrypt'
const INVALID_MESSAGE_OBJECT = 'Invalid message object'

const storeKeys = {
  messageSubscriptionStart: 'message_subscription_start',
  messageStatuses: 'message_statuses'
}

const MESSAGE_FORMAT = {
  type: 'object',
  required: ['created'],
  properties: {
    content: { type: 'string' },
    media: { type: 'array' },
    created: { type: 'number' },
    decryption: {
      type: 'object',
      required: ['keys', 'roomId'],
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' }
        },
        roomId: { type: 'string' }
      }
    }
  }
}
const validator = new Ajv()
const validateMessage = validator.compile(MESSAGE_FORMAT)
const limiter = new Bottleneck({ maxConcurrent: 25 })

/**
 * Origin Messaging Client
 *
 * To use:
 *
 * ```
 * const messaging = new Messaging(options)
 * await messaging.init(this.address)
 * await messaging.startConversing()
 * // Once ready:
 * await messaging.sendConvMessage(aliceAddress, { content: 'Hi' })
 * // Once someone else's messages have arrived
 * const messages = messaging.getAllMessages(aliceAddress)
 * ```
 *
 */
class Messaging {
  constructor({
    contractService,
    ecies,
    messagingNamespace,
    globalKeyServer,
    personalSign = true
  }) {
    this.contractService = contractService
    this.web3 = this.contractService.web3
    this.sharedRooms = {}
    this.convs = {}
    this.ecies = ecies
    this.events = new EventEmitter()
    this.globalKeyServer = globalKeyServer
    this.personalSign = personalSign
    this.messagingNamespace = messagingNamespace
    this.cookieStorage = new cookieStorage({
      path:
        typeof location === 'object' && location.pathname
          ? location.pathname
          : '/'
    })
    // Use cookie storage
    this.currentStorage = this.cookieStorage
    this._registryCache = {}
  }

  onAccount(accountKey) {
    if ((accountKey && !this.account_key) || accountKey != this.account_key) {
      this.checkSetCurrentStorage(accountKey)
      this.init(accountKey)
    }
  }

  checkSetCurrentStorage(accountKey) {
    if (sessionStorage.getItem(`${MESSAGING_KEY}:${accountKey}`)) {
      this.currentStorage = sessionStorage
    } else {
      this.currentStorage = this.cookieStorage
    }
  }

  // Helper function for use by outside services
  preGenKeys(web3Account) {
    const sigPhrase = PROMPT_MESSAGE
    const signature = web3Account.sign(sigPhrase).signature

    const sigKey = signature.substring(0, 66)
    const msgAccount = this.web3.eth.accounts.privateKeyToAccount(sigKey)

    const pubMsg = PROMPT_PUB_KEY + msgAccount.address
    const pubSig = web3Account.sign(pubMsg).signature
    return {
      account: web3Account.address,
      sig_phrase: sigPhrase,
      sig_key: sigKey,
      pub_msg: pubMsg,
      pub_sig: pubSig
    }
  }

  async onPreGenKeys({ address, signatureKey, pubMessage, pubSignature }) {
    debug('onPreGenKeys')
    const accounts = await this.web3.eth.getAccounts()
    if (address === accounts[0]) {
      this.currentStorage = sessionStorage
      this.setKeyItem(`${MESSAGING_KEY}:${address}`, signatureKey)
      this.setKeyItem(`${MESSAGING_PHRASE}:${address}`, PROMPT_MESSAGE)
      this.setKeyItem(`${PUB_MESSAGING}:${address}`, pubMessage)
      this.setKeyItem(`${PUB_MESSAGING_SIG}:${address}`, pubSignature)
      this.pub_sig = pubSignature
      this.pub_msg = pubMessage
      if (address == this.account_key) {
        this.startConversing()
      }
    }
  }

  setKeyItem(key, value) {
    this.currentStorage.setItem(key, value)
  }

  getKeyItem(key) {
    return this.currentStorage.getItem(key)
  }

  getMessagingKey() {
    return this.getKeyItem(`${MESSAGING_KEY}:${this.account_key}`)
  }

  getMessagingPhrase() {
    return this.getKeyItem(`${MESSAGING_PHRASE}:${this.account_key}`)
  }

  getPublicMessagingSignature() {
    return this.getKeyItem(`${PUB_MESSAGING_SIG}:${this.account_key}`)
  }

  async initKeys() {
    const sigKey = this.getMessagingKey()
    const sigPhrase = this.getMessagingPhrase()
    // lock in the message to the hardcoded one
    if (sigKey && sigPhrase == PROMPT_MESSAGE) {
      await this.setAccount(sigKey, sigPhrase)
    } else {
      await this.promptToEnable()
    }
  }

  // throws exception when user denies signature
  async startConversing() {
    debug('startConversing')
    if (!this.account || !this.getPublicMessagingSignature()) {
      // Remote has been initialized
      await this.initKeys()
    } else {
      this.convsEnabled = true
    }
  }

  async init(key) {
    debug('init', key)

    // Reset state...
    this.convs = {}
    this.convsEnabled = false
    clearInterval(this.refreshIntervalId)

    this.account_key = key
    this.account = undefined
    this.events.emit('new', this.account_key)
    // just start it up here
    if (await this.initRemote()) {
      this.pub_sig = this.getKeyItem(`${PUB_MESSAGING_SIG}:${this.account_key}`)
      this.pub_msg = this.getKeyItem(`${PUB_MESSAGING}:${this.account_key}`)

      this.events.emit('initialized', this.account_key)
      if (this.convsEnabled || this.getMessagingKey()) {
        await this.initKeys()
      }
    }
    // bootstrap read status
    const scopedSubStartKeyName = `${storeKeys.messageSubscriptionStart}:${this.account_key}`
    if (!localStorage.getItem(scopedSubStartKeyName)) {
      localStorage.setItem(scopedSubStartKeyName, JSON.stringify(Date.now()))
    }
    const scopedStatusesKeyName = `${storeKeys.messageStatuses}:${this.account_key}`
    if (!localStorage.getItem(scopedStatusesKeyName)) {
      localStorage.setItem(scopedStatusesKeyName, JSON.stringify({}))
    }
  }

  async initRemote() {
    debug('initRemote')
    this.events.emit('initRemote')
    return true
  }

  signRegistry() {
    return this.pub_sig
  }

  signMessaging(key, data) {
    return this.account.sign(data).signature
  }

  signInitPair(key, data) {
    return this.account.sign(data).signature
  }

  async verifySignature() {
    return (/* signature, key, data */) => {
      // pass through for now
      return true
    }
  }

  async getGlobalKey(key) {
    if (!this.globalKeyServer) {
      throw new Error('Global key server required')
    }
    try {
      const res = await fetch(`${this.globalKeyServer}/accounts/${key}`, {
        headers: { 'content-type': 'application/json' }
      })
      return await res.json()
    } catch (e) {
      return
    }
  }

  async getRegisteredKey(key) {
    const entry = this._registryCache[key]
    if (entry) {
      return entry
    }
    const serverResponse = await fetch(
      `${this.globalKeyServer}/accounts/${key}`
    )
    if (serverResponse.status === 200) {
      const jEntry = await serverResponse.json()
      this._registryCache[key] = jEntry
      return jEntry
    }
  }

  async initMessaging() {
    debug('initMessaging')
    const entry = await this.getRemoteMessagingSig()
    const accountMatch = entry && entry.address == this.account.address
    if (!(this.pub_sig && this.pub_msg)) {
      if (accountMatch && entry.sig && entry.msg) {
        this.pub_sig = entry.sig
        this.pub_msg = entry.msg
      } else {
        await this.promptForSignature()
      }
    } else if (!accountMatch) {
      await this.setRemoteMessagingSig()
    }
    this.events.emit('ready', this.account_key)
    this.loadMyConvs()
  }

  async getRemoteMessagingSig() {
    const entry = await this.getGlobalKey(this.account_key)
    if (entry && entry.address == this.account.address) {
      return entry
    }
  }

  async setRemoteMessagingSig() {
    debug('setRemoteMessagingSig', this.account_key)
    const msg = this.getMessagingPhrase()
    const body = {
      signature: this.pub_sig,
      data: {
        address: this.account.address,
        msg: this.pub_msg,
        pub_key: this.account.publicKey,
        ph: msg,
        phs: this.account.sign(msg).signature
      }
    }
    const response = await fetch(
      `${this.globalKeyServer}/accounts/${this.account_key}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' }
      }
    )
    if (response.status != 200) {
      console.log('setting registry failed:', response)
    }
  }

  async setAccount(keyStr, phraseStr) {
    debug('setAccount', keyStr, phraseStr)
    this.account = this.web3.eth.accounts.privateKeyToAccount(keyStr)
    this.account.publicKey =
      '0x' +
      secp256k1
        .publicKeyCreate(new Buffer(keyStr.substring(2), 'hex'), false)
        .slice(1)
        .toString('hex')
    // send it to local storage
    const scopedMessagingKeyName = `${MESSAGING_KEY}:${this.account_key}`
    this.setKeyItem(scopedMessagingKeyName, keyStr)
    //set phrase in the cookie
    const scopedMessagingPhraseName = `${MESSAGING_PHRASE}:${this.account_key}`
    this.setKeyItem(scopedMessagingPhraseName, phraseStr)
    await this.initMessaging()
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Enable messsaging by getting the user to sign the magic text.
   */
  async promptToEnable() {
    debug('promptToEnable', this.account_key)
    const sigPhrase = PROMPT_MESSAGE
    const signer = this.personalSign ? this.web3.eth.personal : this.web3.eth
    const signature = await signer.sign(sigPhrase, this.account_key)
    debug('signedSig', signature)
    this.events.emit('signedSig')

    // 32 bytes in hex + 0x
    const sigKey = signature.substring(0, 66)

    // Delay to prevent hidden MetaMask popup
    await this.sleep(500)
    await this.setAccount(sigKey, sigPhrase)
  }

  async promptForSignature() {
    debug('promptForSignature', this.account_key)
    this.pub_msg = PROMPT_PUB_KEY + this.account.address
    const signer = this.personalSign ? this.web3.eth.personal : this.web3.eth
    this.pub_sig = await signer.sign(this.pub_msg, this.account_key)
    const scopedPubSigKeyName = `${PUB_MESSAGING_SIG}:${this.account_key}`
    this.setKeyItem(scopedPubSigKeyName, this.pub_sig)
    const scopedPubMessagingKeyName = `${PUB_MESSAGING}:${this.account_key}`
    this.setKeyItem(scopedPubMessagingKeyName, this.pub_msg)
    this.setRemoteMessagingSig()
  }

  generateRoomId(converser1, converser2) {
    const keys = [
      this.web3.utils.toChecksumAddress(converser1),
      this.web3.utils.toChecksumAddress(converser2)
    ]
    keys.sort()
    return keys.join('-')
  }

  isRoomId(str) {
    return str.includes('-')
  }

  getRecipients(key) {
    return key.split('-')
  }

  getSharedKeys(roomId) {
    const room = this.convs[roomId]
    return room ? room.keys || [] : []
  }

  getConvo(ethAddress) {
    const roomId = this.generateRoomId(this.account_key, ethAddress)
    return this.convs[roomId]
  }

  hasConversedWith(ethAddress) {
    const roomId = this.generateRoomId(this.account_key, ethAddress)
    return this.convs[roomId]
  }

  decryptEmsg(ivStr, msg, key) {
    const buffer = CryptoJS.AES.decrypt(msg, key, {
      iv: CryptoJS.enc.Base64.parse(ivStr)
    })
    let outText
    try {
      outText = buffer.toString(CryptoJS.enc.Utf8)
    } catch (error) {
      return
    }

    if (outText && outText.length > 6) {
      const verifyText = outText.slice(0, -6)
      const shaCheck = outText.substr(-6)
      if (
        shaCheck ==
        CryptoJS.enc.Base64.stringify(CryptoJS.SHA1(verifyText)).substr(0, 6)
      ) {
        return verifyText
      }
    }
  }

  /**
   * Handles reading from content update object.
   *
   * New keys are stored on the convObj, while a decrypted message
   * fires a callback.
   */
  processContent(content, convObj, onMessage, onEncrypted) {
    if (content.type == 'keys') {
      this.processKeys(content, convObj)
    } else if (content.type == 'msg') {
      const decrypted = this.decryptMessage(content, convObj)
      if (decrypted.error == COULD_NOT_DECRYPT) {
        onEncrypted(content.emsg, content.address)
      } else if (decrypted.error == INVALID_MESSAGE_OBJECT) {
        // Do nothing
      } else if (decrypted.content) {
        onMessage(decrypted.content, content.address)
      }
    }
  }

  /**
   * Adds any of my keys to the conversation
   */
  processKeys(content, convObj) {
    for (const v of content.keys) {
      if (v.address == this.account_key) {
        let key
        try {
          key = this.ecDecrypt(v.ekey)
        } catch (e) {
          /* Ignore */
        }
        if (key && !convObj.keys.includes(key)) {
          convObj.keys.push(key)
        }
      }
    }
  }

  /**
   * Decrypts a message using the keys from a conversation.
   */
  decryptMessage(content, convObj) {
    const v = content
    for (const key of convObj.keys) {
      const buffer = this.decryptEmsg(v.i, v.emsg, key)
      if (buffer != undefined) {
        let obj = buffer
        try {
          obj = JSON.parse(buffer)
        } catch (error) {
          return { error: INVALID_MESSAGE_OBJECT }
        }
        if (!validateMessage(obj)) {
          // force it to be an object
          return { error: INVALID_MESSAGE_OBJECT }
        }
        return { content: obj }
      }
    }
    return { error: COULD_NOT_DECRYPT }
  }

  onMessageUpdate(entry) {
    debug('we got a update entry:', entry)
    const { content, conversationId, conversationIndex } = entry
    if (content && conversationId) {
      if (!this.convs[conversationId]) {
        this.getRoom(conversationId)
      } else {
        const convObj = this.convs[conversationId]
        if (conversationIndex != convObj.conversationIndex + 1) {
          this.processContent(
            entry.content,
            convObj,
            (msg, address) => {
              const message = this.toMessage(
                msg,
                conversationId,
                entry,
                address
              )
              convObj.messages.push(message)
              debug('message:', message)
              this.events.emit('msg', message)
            },
            (msg, address) => {
              this.events.emit(
                'emsg',
                this.toMessage(msg, conversationId, entry, address)
              )
            }
          )
          convObj.lastConversationIndex = entry.conversationIndex
          convObj.messageCount = entry.conversationIndex + 1
        } else {
          // we are missing a message
          this.getRoom(conversationId)
        }
      }
    }
  }

  getMessageId(roomId, container) {
    return roomId + '.' + container.conversationIndex
  }

  toMessage(msg, roomId, container, address) {
    return {
      msg: msg,
      room_id: roomId,
      index: container.conversationIndex,
      address,
      hash: this.getMessageId(roomId, container)
    }
  }

  async getRoom(roomId) {
    const convObj = { keys: [], messages: [] }
    this.convs[roomId] = convObj

    const messages = await limiter.schedule(async () => {
      const res = await fetch(`${this.globalKeyServer}/messages/${roomId}`, {
        headers: { 'content-type': 'application/json' }
      })
      return await res.json()
    })

    messages.forEach(entry => {
      this.processContent(
        entry.content,
        convObj,
        (msg, address) => {
          const message = this.toMessage(msg, roomId, entry, address)
          convObj.messages.push(message)
          debug('msg:', message)
          this.events.emit('msg', message)
        },
        (msg, address) => {
          this.events.emit('emsg', this.toMessage(msg, roomId, entry, address))
        }
      )
      convObj.lastConversationIndex = entry.conversationIndex
      convObj.messageCount = entry.conversationIndex + 1
    })
  }

  getMessagesCount(remoteEthAddress) {
    const roomId = this.generateRoomId(this.account_key, remoteEthAddress)
    const convObj = this.convs[roomId]

    if (convObj) {
      return convObj.messageCount
    }
    return 0
  }

  async fetchConvs() {
    const res = await fetch(
      `${this.globalKeyServer}/conversations/${this.account_key}`,
      {
        headers: { 'content-type': 'application/json' }
      }
    )
    return await res.json()
  }

  listenForUpdates() {
    if (this.ws) {
      this.ws.close()
    }
    const wsServer = this.globalKeyServer.replace(/^http/, 'ws')
    const wsUrl = `${wsServer}/message-events/${this.account_key}`
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onmessage = e => this.onMessageUpdate(JSON.parse(e.data))

    //reconnect to messaging
    ws.onclose = e => {
      if (e.code != 1000) {
        // If this is an abnormal close, try to reopen soon.
        setTimeout(() => {
          if (this.ws === ws) {
            // load them back up in case we miss something
            this.loadMyConvs()
          }
        }, 30000)
      }
    }
  }

  async loadMyConvs() {
    debug('loading convs:')
    for (const conv of await this.fetchConvs()) {
      // TODO: make use of the count and do actual lazy loading!
      this.getRoom(conv.id)
    }
    this.listenForUpdates()
  }

  async getMyConvs() {
    const outConvs = {}
    for (const id of Object.keys(this.convs)) {
      const recipients = this.getRecipients(id)
      if (recipients.length == 2) {
        const remoteEthAddress = recipients.find(
          addr => addr !== this.account_key
        )
        outConvs[remoteEthAddress] = new Date()
      } else {
        outConvs[id] = new Date()
      }
    }
    return outConvs
  }

  /**
   * Read from our local cache for messages to or from particular user
   */
  getAllMessages(remoteEthAddress) {
    const roomId = this.generateRoomId(this.account_key, remoteEthAddress)
    const convObj = this.convs[roomId]

    if (convObj) {
      return convObj.messages
    }
    return []
  }

  ecEncrypt(text, pubKey) {
    const plaintext = new Buffer(text)
    if (!pubKey) {
      pubKey = this.account.publicKey
    }
    return this.ecies
      .encrypt(new Buffer(pubKey.substring(2), 'hex'), plaintext)
      .toString('hex')
  }

  ecDecrypt(buffer) {
    if (this.account) {
      return this.ecies
        .decrypt(
          new Buffer(this.account.privateKey.substring(2), 'hex'),
          new Buffer(buffer, 'hex')
        )
        .toString('utf8')
    }
  }

  async canConverseWith(remoteEthAddress) {
    const accountKey = this.account_key
    const address = this.web3.utils.toChecksumAddress(remoteEthAddress)
    const entry = await this.getRegisteredKey(address)

    return this.canSendMessages() && accountKey !== address && entry
  }

  async canReceiveMessages(remoteEthAddress) {
    const address = this.web3.utils.toChecksumAddress(remoteEthAddress)
    return Boolean(await this.getRegisteredKey(address))
  }

  canSendMessages() {
    return this.account && this.account_key
  }

  async addRoomMsg(conversationId, conversationIndex, content) {
    const data = stringify({ conversationId, conversationIndex, content })
    const signature = this.account.sign(data).signature
    const response = await fetch(
      `${this.globalKeyServer}/messages/${conversationId}/${conversationIndex}`,
      {
        method: 'POST',
        body: JSON.stringify({ content, signature }),
        headers: { 'content-type': 'application/json' }
      }
    )
    if (response.status != 200) {
      // for whatever reason we cannot create a message might want to refresh
      // status 409 is semi expected because that's a conflict in indicies
      return false
    }
    return true
  }

  async startConv(remoteEthAddress) {
    debug('startConv', remoteEthAddress)
    const entry = await this.getRegisteredKey(remoteEthAddress)

    if (!entry) {
      debug('remote account messaging disabled')
      return
    }

    const roomId = this.generateRoomId(this.account_key, remoteEthAddress)
    const convObj = this.convs[roomId] || { keys: [], messageCount: 0 }

    if (!convObj.keys.length) {
      //
      // a conversation haven't even been started yet
      //
      const conversationIndex = convObj ? convObj.messageCount : 0
      const encryptKey = cryptoRandomString({ length: 32 }).toString('hex')

      const keysContent = {
        type: 'keys',
        address: this.account_key,
        keys: [
          {
            ekey: this.ecEncrypt(encryptKey),
            maddress: this.account.address,
            address: this.account_key
          },
          {
            ekey: this.ecEncrypt(encryptKey, entry.pub_key),
            maddress: entry.address,
            address: remoteEthAddress
          }
        ]
      }
      const result = await this.addRoomMsg(
        roomId,
        conversationIndex,
        keysContent
      )

      if (result) {
        convObj.keys.push(encryptKey)
        convObj.messageCount += 1
      }
    }
    return convObj
  }

  async createEncrypted(address, convObj, messageObj) {
    let remoteEthAddress = address
    if (!this.web3.utils.isAddress(remoteEthAddress)) {
      throw new Error(`${remoteEthAddress} is not a valid Ethereum address`)
    }
    remoteEthAddress = this.web3.utils.toChecksumAddress(remoteEthAddress)

    if (typeof messageObj == 'string') {
      messageObj = { content: messageObj }
    }
    const message = Object.assign({}, messageObj)
    // set timestamp
    message.created = Date.now()

    if (!validateMessage(message)) {
      debug('ERR: invalid message')
      return
    }
    const key = convObj.keys[0]
    const iv = CryptoJS.lib.WordArray.random(16)
    const messageStr = JSON.stringify(message)
    const shaSub = CryptoJS.enc.Base64.stringify(
      CryptoJS.SHA1(messageStr)
    ).substr(0, 6)
    const encmsg = CryptoJS.AES.encrypt(messageStr + shaSub, key, {
      iv: iv
    }).toString()
    const ivStr = CryptoJS.enc.Base64.stringify(iv)

    return {
      type: 'msg',
      emsg: encmsg,
      i: ivStr,
      address: this.account_key
    }
  }

  async sendConvMessage(roomIdOrAddress, messageObj) {
    debug('sendConvMessage', roomIdOrAddress, messageObj)
    if (this._sending_message) {
      debug('ERR: already sending message')
      return
    }
    let remoteEthAddress, roomId
    if (this.isRoomId(roomIdOrAddress)) {
      roomId = roomIdOrAddress
      remoteEthAddress = this.getRecipients(roomId).find(
        addr => addr !== this.account_key
      )
    } else {
      remoteEthAddress = roomIdOrAddress
      if (!this.web3.utils.isAddress(remoteEthAddress)) {
        throw new Error(`${remoteEthAddress} is not a valid Ethereum address`)
      }
      roomId = this.generateRoomId(this.account_key, remoteEthAddress)
    }
    remoteEthAddress = this.web3.utils.toChecksumAddress(remoteEthAddress)
    const convObj = await this.startConv(remoteEthAddress)
    if (!convObj) {
      debug('ERR: no room to send message to')
      return
    }

    const encryptedContent = await this.createEncrypted(
      remoteEthAddress,
      convObj,
      messageObj
    )
    if (!encryptedContent) {
      return
    }

    this._sending_message = true
    // include a random iv str so that people can't match strings of the same message
    if (await this.addRoomMsg(roomId, convObj.messageCount, encryptedContent)) {
      debug('room.add OK')
      //do something different if this succeeds
    } else {
      debug('Err: cannot add message.')
    }
    this._sending_message = false
    return roomId
  }

  async createOutOfBandMessage(address, messageObj) {
    debug('createOutOfBandMessage', address, messageObj)
    let remoteEthAddress = address
    if (!this.web3.utils.isAddress(remoteEthAddress)) {
      throw new Error(`${remoteEthAddress} is not a valid Ethereum address`)
    }
    remoteEthAddress = this.web3.utils.toChecksumAddress(remoteEthAddress)
    const convObj = await this.startConv(remoteEthAddress)
    if (!convObj) {
      debug('ERR: no room to send message to')
      return
    }
    const encryptedContent = await this.createEncrypted(
      remoteEthAddress,
      convObj,
      messageObj
    )
    if (!encryptedContent) {
      return
    }
    const myAddress = this.web3.utils.toChecksumAddress(remoteEthAddress)
    encryptedContent.to = myAddress
    return encryptedContent
  }

  async decryptOutOfBandMessage(message) {
    // We don't know which one will be us, because we could be
    // reading our own message.
    const addresses = [message.address, message.to].map(x => {
      if (!this.web3.utils.isAddress(x)) {
        throw new Error(`${x} is not a valid Ethereum address`)
      }
      return this.web3.utils.toChecksumAddress(x)
    })
    // Sort my address to the end of the array
    // Making the the first address not me (unless I'm messaging myself)
    addresses.sort(x => (x == this.account_key ? 1 : -1))
    const remoteEthAddress = addresses[0]

    const convObj = await this.startConv(remoteEthAddress)
    console.log('Conversation object', convObj)
    if (!convObj) {
      debug('ERR: no room to get message from')
      return
    }
    return this.decryptMessage(message, convObj)
  }

  // messages supplied by the 'msg' event have status included
  // this is a convenience method for tracking status on spoofed messages
  getStatus({ hash }) {
    const messageStatuses = JSON.parse(
      localStorage.getItem(`${storeKeys.messageStatuses}:${this.account_key}`)
    )
    const status =
      messageStatuses && messageStatuses[hash] === READ_STATUS
        ? READ_STATUS
        : UNREAD_STATUS
    return status
  }

  // we allow the entire message to be passed in (for consistency with other resources + convenience)
  // however all we are updating is the status
  set({ hash, status }) {
    const scopedStatusesKeyName = `${storeKeys.messageStatuses}:${this.account_key}`
    const messageStatuses = JSON.parse(
      localStorage.getItem(scopedStatusesKeyName)
    )
    messageStatuses[hash] = status
    localStorage.setItem(scopedStatusesKeyName, JSON.stringify(messageStatuses))
  }
}

export default Messaging
