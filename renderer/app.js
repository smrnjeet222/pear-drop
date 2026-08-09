const api = window.peardrop

const elements = {
  actionError: document.getElementById('action-error'),
  actionErrorMessage: document.getElementById('action-error-message'),
  appLive: document.getElementById('app-live'),
  capabilityBlock: document.getElementById('capability-block'),
  capabilityInput: document.getElementById('capability-input'),
  capabilityValue: document.getElementById('capability-value'),
  cancelReceive: document.getElementById('cancel-receive'),
  chooseFile: document.getElementById('choose-file'),
  completionBlock: document.getElementById('completion-block'),
  copyCapability: document.getElementById('copy-capability'),
  copyConfirmation: document.getElementById('copy-confirmation'),
  openReceived: document.getElementById('open-received'),
  outputPath: document.getElementById('output-path'),
  receiveBadge: document.getElementById('receive-badge'),
  receiveBytes: document.getElementById('receive-bytes'),
  receiveError: document.getElementById('receive-error'),
  receiveErrorMessage: document.getElementById('receive-error-message'),
  receiveFileDetail: document.getElementById('receive-file-detail'),
  receiveForm: document.getElementById('receive-form'),
  receivePanel: document.getElementById('receive-panel'),
  receiveProgress: document.getElementById('receive-progress'),
  receiveProgressBlock: document.getElementById('receive-progress-block'),
  receiveProgressLabel: document.getElementById('receive-progress-label'),
  receiveProgressValue: document.getElementById('receive-progress-value'),
  receiveState: document.getElementById('receive-state'),
  receiveStateLabel: document.getElementById('receive-state-label'),
  resetReceive: document.getElementById('reset-receive'),
  resetSend: document.getElementById('reset-send'),
  sendBadge: document.getElementById('send-badge'),
  sendBytes: document.getElementById('send-bytes'),
  sendError: document.getElementById('send-error'),
  sendErrorMessage: document.getElementById('send-error-message'),
  sendFile: document.getElementById('send-file'),
  sendPanel: document.getElementById('send-panel'),
  sendProgress: document.getElementById('send-progress'),
  sendProgressBlock: document.getElementById('send-progress-block'),
  sendProgressLabel: document.getElementById('send-progress-label'),
  sendProgressValue: document.getElementById('send-progress-value'),
  sendState: document.getElementById('send-state'),
  sendStateLabel: document.getElementById('send-state-label'),
  stopSharing: document.getElementById('stop-sharing')
}

const SEND_STATUS = {
  preparing: ['Preparing file', 'Preparing'],
  announcing: ['Making the file available', 'Connecting'],
  sharing: ['Ready to receive', 'Sharing'],
  stopping: ['Stopping the handoff', 'Stopping'],
  failed: ['Could not share this file', 'Stopped']
}

const RECEIVE_STATUS = {
  discovering: ['Looking for the sender', 'Discovering'],
  'awaiting-destination': ['Choose where to save the file', 'Save location'],
  transferring: ['Receiving the file', 'Receiving'],
  verifying: ['Checking the received file', 'Verifying'],
  cancelling: ['Cancelling the handoff', 'Cancelling'],
  completed: ['File received', 'Complete'],
  failed: ['Could not receive this file', 'Stopped']
}

const model = {
  mode: null,
  state: 'idle',
  requestId: null,
  file: null,
  capability: null,
  bytes: null,
  peers: null,
  outputPath: null,
  progress: null,
  error: null,
  actionError: null,
  workerFailed: false,
  busy: false
}

let eventVersion = 0
let copyTimer = null
let lastAnnouncement = ''

function setHidden(element, hidden) {
  element.hidden = hidden
}

function setDisabled(element, disabled) {
  element.disabled = disabled
}

function setText(element, value = '') {
  element.textContent = value
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function fileSummary(file) {
  if (!file) return ''
  return `${file.name} · ${formatBytes(file.size)}`
}

function progressValues() {
  const source = model.progress || model.bytes
  if (!source) return null
  const transferred = Math.max(0, source.transferred || 0)
  const total = Math.max(0, source.total || 0)
  const percentage = total === 0 ? 100 : Math.min(100, Math.round((transferred / total) * 100))
  return { transferred, total, percentage, phase: source.phase }
}

function announce(message) {
  if (!message || message === lastAnnouncement) return
  lastAnnouncement = message
  setText(elements.appLive, message)
}

function renderProgress(prefix, visible, label) {
  const block = elements[`${prefix}ProgressBlock`]
  setHidden(block, !visible)
  if (!visible) return

  const values = progressValues() || { transferred: 0, total: model.file?.size || 0, percentage: 0 }
  const progress = elements[`${prefix}Progress`]
  progress.value = values.percentage
  setText(elements[`${prefix}ProgressLabel`], label)
  setText(elements[`${prefix}ProgressValue`], `${values.percentage}%`)
  setText(
    elements[`${prefix}Bytes`],
    `${formatBytes(values.transferred)} of ${formatBytes(values.total)}`
  )
}

function renderSend() {
  const active = model.mode === 'send' && model.state !== 'idle'
  const status = SEND_STATUS[model.state] || SEND_STATUS.preparing
  const failed = active && model.state === 'failed'
  const canStop = active && ['preparing', 'announcing', 'sharing'].includes(model.state)
  const progressVisible = active && ['preparing', 'announcing'].includes(model.state)
  const capabilityVisible = active && model.state === 'sharing' && !!model.capability

  setHidden(elements.chooseFile, active)
  setDisabled(
    elements.chooseFile,
    model.busy || (model.mode === 'receive' && model.state !== 'idle')
  )
  setHidden(elements.sendState, !active)
  elements.sendPanel.classList.toggle(
    'is-muted',
    model.mode === 'receive' && model.state !== 'idle'
  )
  elements.sendPanel.setAttribute(
    'aria-busy',
    String(active && !['sharing', 'failed'].includes(model.state))
  )

  if (!active) return

  setText(elements.sendStateLabel, status[0])
  setText(elements.sendBadge, status[1])
  elements.sendBadge.classList.toggle('is-error', failed)
  setText(elements.sendFile, fileSummary(model.file))
  renderProgress('send', progressVisible, model.state === 'announcing' ? 'Prepared' : 'Preparing')

  setHidden(elements.capabilityBlock, !capabilityVisible)
  if (capabilityVisible) setText(elements.capabilityValue, model.capability)

  setHidden(elements.sendError, !failed)
  if (failed) setText(elements.sendErrorMessage, model.error?.message || 'Retry the handoff.')

  setHidden(elements.stopSharing, !canStop)
  setDisabled(elements.stopSharing, model.busy)
  setHidden(elements.resetSend, !failed)
  setDisabled(elements.resetSend, model.busy || model.workerFailed)
  setDisabled(elements.copyCapability, model.busy || model.workerFailed)
}

function renderReceive() {
  const active = model.mode === 'receive' && model.state !== 'idle'
  const status = RECEIVE_STATUS[model.state] || RECEIVE_STATUS.discovering
  const failed = active && model.state === 'failed'
  const completed = active && model.state === 'completed'
  const canCancel =
    active &&
    ['discovering', 'awaiting-destination', 'transferring', 'verifying'].includes(model.state)
  const progressVisible = active && ['transferring', 'verifying', 'completed'].includes(model.state)
  const formBlocked = model.busy || (model.mode === 'send' && model.state !== 'idle')

  setHidden(elements.receiveForm, active)
  setDisabled(elements.capabilityInput, formBlocked)
  setDisabled(elements.receiveForm.querySelector('button'), formBlocked)
  setHidden(elements.receiveState, !active)
  elements.receivePanel.classList.toggle(
    'is-muted',
    model.mode === 'send' && model.state !== 'idle'
  )
  elements.receivePanel.setAttribute(
    'aria-busy',
    String(active && !['completed', 'failed'].includes(model.state))
  )

  if (!active) return

  setText(elements.receiveStateLabel, status[0])
  setText(elements.receiveBadge, status[1])
  elements.receiveBadge.classList.toggle('is-error', failed)
  setText(
    elements.receiveFileDetail,
    model.file
      ? fileSummary(model.file)
      : model.state === 'discovering'
        ? 'This can take up to 15 seconds.'
        : ''
  )

  renderProgress(
    'receive',
    progressVisible,
    model.state === 'completed'
      ? 'Received'
      : model.state === 'verifying'
        ? 'Received'
        : 'Receiving'
  )

  setHidden(elements.completionBlock, !completed || !model.outputPath)
  if (completed && model.outputPath) setText(elements.outputPath, model.outputPath)
  setDisabled(elements.openReceived, model.busy)

  setHidden(elements.receiveError, !failed)
  if (failed) setText(elements.receiveErrorMessage, model.error?.message || 'Retry the handoff.')

  setHidden(elements.cancelReceive, !canCancel)
  setDisabled(elements.cancelReceive, model.busy)
  setHidden(elements.resetReceive, !failed && !completed)
  setText(elements.resetReceive, completed ? 'Receive another' : 'Try again')
  setDisabled(elements.resetReceive, model.busy || model.workerFailed)
}

function render() {
  setHidden(elements.actionError, !model.actionError)
  if (model.actionError) setText(elements.actionErrorMessage, model.actionError)
  renderSend()
  renderReceive()
}

function applyState(message) {
  const previousMode = model.mode
  const previousState = model.state

  model.mode = message.mode ?? null
  model.state = message.state || 'idle'
  model.requestId = message.requestId || null
  model.file = message.file || null
  model.capability = message.capability || null
  model.bytes = message.bytes || null
  model.peers = Number.isInteger(message.peers) ? message.peers : null
  model.outputPath = message.outputPath || null
  model.progress = null
  model.error = null
  model.actionError = null
  model.workerFailed = false

  if (model.state === 'idle') {
    model.mode = null
    model.requestId = null
    if (previousMode === 'receive' && previousState !== 'idle') elements.capabilityInput.value = ''
  }

  const status = model.mode === 'send' ? SEND_STATUS[model.state] : RECEIVE_STATUS[model.state]
  if (status) announce(status[0])
  render()
}

function onEvent(message) {
  if (!message || typeof message !== 'object') return
  eventVersion += 1

  if (message.type === 'state.changed') {
    applyState(message)
    return
  }

  if (message.type === 'receive.metadata' && message.requestId === model.requestId) {
    model.file = message.file
    render()
    return
  }

  if (message.type === 'transfer.progress' && message.requestId === model.requestId) {
    model.progress = {
      phase: message.phase,
      transferred: message.transferred,
      total: message.total
    }
    render()
    return
  }

  if (message.type === 'transfer.error') {
    const workerFailed = message.error.code.startsWith('WORKER_')
    if (message.requestId === model.requestId && model.state !== 'idle') {
      model.error = message.error
      if (workerFailed) {
        model.state = 'failed'
        model.workerFailed = true
      }
      announce(message.error.message)
    } else {
      model.actionError = message.error.message
      if (!workerFailed) {
        elements.capabilityInput.setAttribute('aria-invalid', 'true')
        elements.capabilityInput.focus()
      }
    }
    render()
  }
}

function actionFailure(message) {
  model.actionError = message
  announce(message)
  render()
}

async function runAction(action, fallbackMessage) {
  if (model.busy) return null
  model.busy = true
  model.actionError = null
  render()

  try {
    return await action()
  } catch {
    if (!model.error && !model.actionError) actionFailure(fallbackMessage)
    return null
  } finally {
    model.busy = false
    render()
  }
}

async function chooseFile() {
  elements.copyConfirmation.textContent = ''
  await runAction(() => api.chooseAndShare(), 'PearDrop could not start sharing. Try again.')
}

async function receiveFile(event) {
  event.preventDefault()
  const capability = elements.capabilityInput.value
  elements.capabilityInput.removeAttribute('aria-invalid')

  if (capability.trim().length === 0) {
    elements.capabilityInput.setAttribute('aria-invalid', 'true')
    elements.capabilityInput.focus()
    actionFailure("Paste the sender's 64-character PearDrop key.")
    return
  }

  await runAction(
    () => api.receive(capability),
    'PearDrop could not look for the sender. Check the key and try again.'
  )
}

async function cancelTransfer() {
  if (!model.requestId) return
  await runAction(
    () => api.cancel(model.requestId),
    'PearDrop could not cancel the handoff. Try again.'
  )
}

async function resetTransfer() {
  if (!model.requestId) return
  await runAction(
    () => api.reset(model.requestId),
    'PearDrop could not reset the handoff. Restart the app.'
  )
}

async function copyCapability() {
  if (!model.requestId) return
  const result = await runAction(
    () => api.copyCapability(model.requestId),
    'PearDrop could not copy the key. Select it and copy it manually.'
  )
  if (!result) return

  setText(elements.copyConfirmation, 'Copied')
  announce('Read capability copied.')
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => setText(elements.copyConfirmation), 2000)
}

async function openReceived() {
  if (!model.requestId) return
  await runAction(
    () => api.openReceived(model.requestId),
    'PearDrop could not show the received file in its folder.'
  )
}

elements.chooseFile.addEventListener('click', chooseFile)
elements.receiveForm.addEventListener('submit', receiveFile)
elements.stopSharing.addEventListener('click', cancelTransfer)
elements.cancelReceive.addEventListener('click', cancelTransfer)
elements.resetSend.addEventListener('click', resetTransfer)
elements.resetReceive.addEventListener('click', resetTransfer)
elements.copyCapability.addEventListener('click', copyCapability)
elements.openReceived.addEventListener('click', openReceived)
elements.capabilityInput.addEventListener('input', () => {
  elements.capabilityInput.removeAttribute('aria-invalid')
  if (model.state === 'idle') {
    model.actionError = null
    render()
  }
})

const unsubscribe = api.onEvent(onEvent)
window.addEventListener('unload', unsubscribe, { once: true })

const snapshotVersion = eventVersion
api
  .getSnapshot()
  .then((snapshot) => {
    if (eventVersion === snapshotVersion) applyState(snapshot)
  })
  .catch(() => actionFailure('PearDrop could not connect to its transfer worker. Restart the app.'))
