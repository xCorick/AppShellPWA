// =====================================================================
//  TRIVIA UTS · PWA
//  Single page application sin frameworks: router por hash, cliente de
//  la API, manejador de errores y vistas de administrador y jugador.
// =====================================================================

const API_BASE = 'https://userapi-m8ef.onrender.com/api'
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000'
const DEFAULT_DATE = '0001-01-01T00:00:00'

const SESSION_KEY = 'trivia.session'
const RESULT_KEY = 'trivia.lastResult'
const PENDING_KEY = 'trivia.pendingScores'

const REQUEST_TIMEOUT = 70000   // Render (plan gratis) puede tardar ~1 min en despertar
const SLOW_REQUEST_MS = 4000
const QUESTION_TIME = 20        // segundos por pregunta
const POINTS_PER_ANSWER = 10    // la BD calcula total_preguntas = SUM(points) / 10
const LETTERS = ['A', 'B', 'C', 'D']
const PAGE_SIZES = [5, 10, 20]

const ROLE_OPTIONS = [
    { value: 0, label: 'Jugador' },
    { value: 1, label: 'Administrador' }
]

const TABS = {
    ADMIN: [
        { path: '/admin/usuarios', icon: '👥', label: 'Usuarios' },
        { path: '/admin/materias', icon: '📚', label: 'Materias' },
        { path: '/admin/preguntas', icon: '📝', label: 'Preguntas' }
    ],
    USER: [
        { path: '/inicio', icon: '🏆', label: 'Mi progreso' },
        { path: '/jugar', icon: '🎮', label: 'Jugar', also: ['/quiz', '/resultado'] }
    ]
}

const app = document.querySelector('#app')
const tabsNav = document.querySelector('#tabs')
const userChip = document.querySelector('#user-chip')
const btnLogout = document.querySelector('#btn-logout')
const btnInstall = document.querySelector('#btn-install')
const netBanner = document.querySelector('#net-banner')
const toasts = document.querySelector('#toasts')
const dialog = document.querySelector('#dialog')
const loader = document.querySelector('#loader')

let game = null
let cleanups = []
let renderId = 0
let cacheNoticeAt = null
let installPrompt = null
let sessionExpired = false

window.addEventListener('load', () => {
    registerSW()
})

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function shortId(id) {
    return id ? String(id).slice(-4) : '—'
}

function formatScore(value) {
    return Number(value || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('es-MX')
}

function formatDateTime(timestamp) {
    return new Date(timestamp).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function byName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), 'es')
}

function levelClass(score) {
    return score >= 75 ? 'high' : score >= 50 ? 'mid' : 'low'
}

function plural(count, singular, pluralForm) {
    return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`
}

function shuffle(list) {
    const copy = list.slice()
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = copy[i]
        copy[i] = copy[j]
        copy[j] = tmp
    }
    return copy
}

function iconFor(name) {
    const key = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    if (key.includes('mixto')) return '🎲'
    if (key.includes('arte')) return '🎨'
    if (key.includes('histor')) return '🏛️'
    if (key.includes('calc') || key.includes('mate')) return '📐'
    if (key.includes('cienc') || key.includes('fisic') || key.includes('quimic') || key.includes('biolog')) return '🔬'
    if (key.includes('music')) return '🎵'
    if (key.includes('tecno') || key.includes('program') || key.includes('comput')) return '💻'
    if (key.includes('geo')) return '🌎'
    if (key.includes('ingl') || key.includes('idioma') || key.includes('espan') || key.includes('liter')) return '📖'
    return '📘'
}

function readJSON(storage, key, fallback = null) {
    try {
        const raw = storage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
    }
    catch (e) {
        return fallback
    }
}

function writeJSON(storage, key, value) {
    try {
        storage.setItem(key, JSON.stringify(value))
    }
    catch (e) {
        console.warn('No se pudo escribir en el almacenamiento local', e)
    }
}

// ---------------------------------------------------------------------
// Sesión (JWT)
// ---------------------------------------------------------------------
function decodeToken(token) {
    try {
        const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        const json = decodeURIComponent(atob(base64).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
        return JSON.parse(json)
    }
    catch (e) {
        return {}
    }
}

// .NET puede emitir los claims con nombre corto (role) o como URI (.../claims/role)
function readClaim(payload, shortName, suffix) {
    if (payload[shortName]) return payload[shortName]
    const key = Object.keys(payload).find(k => k.endsWith('/' + suffix))
    return key ? payload[key] : null
}

function getSession() {
    const session = readJSON(localStorage, SESSION_KEY)
    if (!session || !session.token) return null
    if (session.exp && Date.now() >= session.exp * 1000) {
        localStorage.removeItem(SESSION_KEY)
        sessionExpired = true
        return null
    }
    return session
}

function saveSession(session) {
    writeJSON(localStorage, SESSION_KEY, session)
}

function homeFor(session) {
    return session.role === 'ADMIN' ? '/admin/usuarios' : '/inicio'
}

async function buildSession(token) {
    const payload = decodeToken(token)
    let info = null
    try {
        info = await api.getSession(token)
    }
    catch (e) {
        console.warn('GetSession falló, se usan los datos del token', e)
    }

    const session = {
        token,
        exp: payload.exp || null,
        id: (info && info.id) || readClaim(payload, 'nameid', 'nameidentifier'),
        userName: (info && info.userName) || readClaim(payload, 'unique_name', 'name'),
        role: String((info && info.role) || readClaim(payload, 'role', 'role') || 'USER').toUpperCase(),
        name: null
    }

    if (session.id) {
        try {
            const user = await api.getUser(session.id)
            session.name = (user && user.name) || null
        }
        catch (e) {
            console.warn('No se pudo obtener el nombre del usuario', e)
        }
    }
    return session
}

async function logout(message, type = 'info') {
    localStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(RESULT_KEY)
    game = null
    await clearApiCache()
    navigate('/login')
    if (message) toast(message, type)
}

// Los datos de la API guardados por el service worker son personales: se borran al salir
async function clearApiCache() {
    if (!('caches' in window)) return
    try {
        const keys = await caches.keys()
        await Promise.all(keys.filter(key => key.startsWith('trivia-api')).map(key => caches.delete(key)))
    }
    catch (e) {
        console.warn('No se pudo limpiar la caché de la API', e)
    }
}

// ---------------------------------------------------------------------
// Manejador de errores de la API
// ---------------------------------------------------------------------
class ApiError extends Error {
    constructor(message, { status = 0, code = null, kind = 'http', details = [], fields = {} } = {}) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        // http | validation | business | network | offline | timeout | unknown
        this.kind = kind
        this.details = details
        this.fields = fields
        this.path = ''
    }
}

// Mensajes que la API devuelve en inglés (UserAPI.Application/Common/ErrorMessages.cs)
const API_MESSAGES = {
    'Unexpected error during create question with options': 'Ocurrió un error inesperado al crear la pregunta',
    'Unexpected error during updating question with options': 'Ocurrió un error inesperado al actualizar la pregunta',
    'Unexpected error during deleting question with options': 'Ocurrió un error inesperado al eliminar la pregunta',
    'Unexpected error during get question with options by question id': 'No se pudo obtener la pregunta',
    'Unexpected error during get question with options page': 'No se pudieron obtener las preguntas',
    'Unexpected error during get random questions': 'No se pudieron obtener las preguntas del juego',
    'Unexpected error during create score': 'No se pudo guardar el score',
    'Unexpected error during getting general progress': 'No se pudo obtener tu progreso general',
    'Unexpected error during getting scores paged': 'No se pudieron obtener tus últimos scores',
    'Unexpected error during getting user global progress': 'No se pudo obtener tu progreso',
    'Unexpected error during create subject': 'Ocurrió un error inesperado al crear la materia',
    'Unexpected error during update subject': 'Ocurrió un error inesperado al actualizar la materia',
    'Unexpected error during deleting subject': 'Ocurrió un error inesperado al eliminar la materia',
    'Unexpected error during getting subject questions for options': 'No se pudieron obtener las materias',
    'Unexpected error during getting subject questions count': 'No se pudo obtener el número de preguntas por materia',
    'An error occurs during register user': 'Ocurrió un error al registrar el usuario',
    'An error occurs during updating user': 'Ocurrió un error al actualizar el usuario',
    'An error occurs during delete user': 'Ocurrió un error al eliminar el usuario',
    'An error occurs during getting user': 'No se pudo obtener el usuario',
    'An error occurs during getting users': 'No se pudieron obtener los usuarios',
    'An error occurs during login': 'Ocurrió un error al iniciar sesión'
}

// Errores de PostgreSQL que no vienen de una regla de negocio (DatabaseException)
const SQL_STATES = {
    '23505': 'Ya existe un registro con esos datos',
    '23503': 'El registro está relacionado con otros datos',
    '23502': 'Falta un dato obligatorio',
    '22P02': 'Uno de los datos tiene un formato inválido',
    '22001': 'Uno de los textos es demasiado largo'
}

const STATUS_MESSAGES = {
    400: 'La solicitud tiene datos inválidos',
    401: 'Tu sesión no es válida o ya expiró',
    403: 'No tienes permiso para realizar esta acción',
    404: 'No se encontró el recurso solicitado',
    405: 'Operación no permitida',
    415: 'Formato de datos no soportado',
    500: 'Ocurrió un error interno en el servidor',
    502: 'El servidor no está disponible en este momento',
    503: 'El servidor no está disponible en este momento',
    504: 'El servidor tardó demasiado en responder'
}

function translateValidation(message) {
    const text = String(message || '')
    if (/could not be converted|JSON value|invalid JSON|not valid JSON|^The value .* is not valid/i.test(text)) return 'Uno de los datos tiene un formato inválido'
    if (/non-empty request body is required/i.test(text)) return 'La solicitud no tiene datos'
    const required = text.match(/^The (\S+) field is required\.?$/i)
    if (required) return `El campo ${required[1]} es requerido`
    return text
}

// "UserName" -> "userName", "$.rol" -> "rol"; así coincide con el name de los inputs
function fieldName(key) {
    const clean = String(key || '').replace(/^\$\.?/, '').split('.').pop()
    return clean ? clean.charAt(0).toLowerCase() + clean.slice(1) : null
}

function parseApiError(status, data) {
    if (data && typeof data === 'object') {
        // Validaciones del modelo: ProblemDetails de ASP.NET { title, errors: { Campo: [mensajes] } }
        if (data.errors && typeof data.errors === 'object') {
            const fields = {}
            const details = []
            Object.entries(data.errors).forEach(([key, messages]) => {
                const list = (Array.isArray(messages) ? messages : [messages]).map(translateValidation)
                const name = fieldName(key)
                if (name) fields[name] = list[0]
                list.forEach(m => {
                    if (!details.includes(m)) details.push(m)
                })
            })
            const message = details.length === 1 ? details[0] : 'Revisa los datos marcados'
            return new ApiError(message, { status, kind: 'validation', details, fields })
        }

        // ErrorResponse { message, code } del ExceptionHandlingMiddleware (o del service worker)
        if (data.message) {
            const code = data.code || null
            // Las reglas de PostgreSQL llegan como "P0409: mensaje"
            const raw = String(data.message).replace(/^[A-Z0-9]{5}:\s*/, '').trim()
            if (code === 'OFFLINE') return new ApiError(raw, { status, code, kind: 'offline' })
            if (API_MESSAGES[raw]) return new ApiError(API_MESSAGES[raw], { status, code })
            if (code && /^P0/.test(code)) return new ApiError(raw, { status, code, kind: 'business' })
            if (code && SQL_STATES[code]) return new ApiError(SQL_STATES[code], { status, code, details: [raw] })
            if (status >= 500) {
                const message = code ? `Error en la base de datos (código ${code})` : STATUS_MESSAGES[500]
                return new ApiError(message, { status, code, details: [raw] })
            }
            return new ApiError(raw, { status, code })
        }

        if (data.title) return new ApiError(STATUS_MESSAGES[status] || data.title, { status })
    }

    if (typeof data === 'string' && data.trim() && data.length < 300 && !/<html/i.test(data)) {
        return new ApiError(data.trim(), { status })
    }
    return new ApiError(STATUS_MESSAGES[status] || `Error inesperado del servidor (${status})`, { status })
}

function networkError(e) {
    if (e && e.name === 'AbortError') {
        return new ApiError('El servidor tardó demasiado en responder. Intenta de nuevo.', { kind: 'timeout' })
    }
    if (!navigator.onLine) {
        return new ApiError('Sin conexión a internet. Revisa tu red e intenta de nuevo.', { kind: 'offline' })
    }
    return new ApiError('No se pudo conectar con el servidor. Intenta de nuevo en unos segundos.', { kind: 'network' })
}

function isConnectionError(err) {
    return err && (err.kind === 'network' || err.kind === 'offline')
}

function toastType(err) {
    return ['validation', 'business', 'offline', 'network', 'timeout'].includes(err.kind) ? 'warning' : 'error'
}

// Punto único para mostrar errores: en un formulario, como toast o en silencio
// (cuando la vista ya pinta el error en su lugar). Un 401 cierra la sesión.
function handleError(error, { form = null, quiet = false } = {}) {
    const err = error instanceof ApiError
        ? error
        : new ApiError('Ocurrió un error inesperado en la aplicación', { kind: 'unknown', details: [error && error.message].filter(Boolean) })
    console.error(error)

    if (err.status === 401 && !err.path.includes('/Auth/LogIn') && getSession()) {
        logout('Tu sesión expiró, vuelve a iniciar sesión', 'warning')
        return err
    }
    if (quiet) return err
    if (form) showFormError(form, err)
    else toast(err.message, toastType(err), { details: err.details })
    return err
}

// ---------------------------------------------------------------------
// Cliente de la API
// ---------------------------------------------------------------------
let pendingRequests = 0
let slowToast = null

function setLoading(delta) {
    pendingRequests = Math.max(0, pendingRequests + delta)
    loader.classList.toggle('active', pendingRequests > 0)
}

function showSlowNotice() {
    if (slowToast) return
    slowToast = toast('El servidor está despertando; la primera respuesta puede tardar hasta un minuto…', 'info', { persistent: true })
}

function hideSlowNotice() {
    if (pendingRequests > 0 || !slowToast) return
    dismissToast(slowToast)
    slowToast = null
}

async function readBody(response) {
    const text = await response.text()
    if (!text) return null
    try {
        return JSON.parse(text)
    }
    catch (e) {
        return text
    }
}

async function request(path, { method = 'GET', body, query, token, timeout = REQUEST_TIMEOUT } = {}) {
    const url = new URL(API_BASE + path)
    Object.entries(query || {}).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value)
    })

    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const session = getSession()
    const bearer = token || (session && session.token)
    if (bearer) headers.Authorization = 'Bearer ' + bearer

    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), timeout)
    const slowTimer = setTimeout(showSlowNotice, SLOW_REQUEST_MS)
    setLoading(1)

    let response
    try {
        response = await fetch(url, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal
        })
    }
    catch (e) {
        const err = networkError(e)
        err.path = path
        throw err
    }
    finally {
        clearTimeout(abortTimer)
        clearTimeout(slowTimer)
        setLoading(-1)
        hideSlowNotice()
    }

    const data = await readBody(response)
    if (!response.ok) {
        const err = parseApiError(response.status, data)
        err.path = path
        throw err
    }
    // El service worker marca las respuestas que salieron de la caché por falta de red
    if (response.headers.get('X-SW-Cache') === 'fallback') {
        noteCacheFallback(Number(response.headers.get('X-SW-Cached-At')) || Date.now())
    }
    return data
}

// La API recibe la entidad completa; lo que la transacción no usa va en null o con su valor por defecto
function userModel({ id = EMPTY_GUID, name, userName, password = null, rol }) {
    return { id, name, userName, password, rol: Number(rol), score: null }
}

function subjectModel({ id = null, name, description }) {
    return { id, created_At: DEFAULT_DATE, isActive: true, name, description, totalQuestions: 0 }
}

function optionModel({ id = null, option, isAnswer, idQuestion = null }) {
    return { id, created_At: DEFAULT_DATE, isActive: true, option, isAnswer, idQuestion }
}

function questionModel({ id = null, question, idSubject = null, options = [] }) {
    return {
        id,
        created_At: DEFAULT_DATE,
        isActive: true,
        question,
        idSubject,
        subjectName: null,
        options: options.map(o => optionModel({ ...o, idQuestion: id }))
    }
}

function scoreModel({ score, isMixed, points, idSubject = null, idUser }) {
    return {
        id: null,
        created_At: DEFAULT_DATE,
        isActive: true,
        score,
        isMixed,
        points,
        idSubject: isMixed ? null : idSubject,
        idUser,
        subject: null
    }
}

const api = {
    login: (userName, password) => request('/Auth/LogIn', { method: 'POST', body: { userName, password } }),
    getSession: token => request('/Auth/GetSession', { token }),
    getUsers: () => request('/Auth/Get/Users'),
    getUser: id => request(`/Auth/Get/User/${id}`),
    createUser: user => request('/Auth/Create/User', { method: 'POST', body: userModel(user) }),
    updateUser: user => request('/Auth/Update/User', { method: 'PUT', body: userModel(user) }),
    deleteUser: id => request(`/Auth/Delete/User/${id}`, { method: 'PUT' }),

    getSubjects: () => request('/Subject/Get/SubjectsForOptions'),
    getSubjectsCount: () => request('/Subject/Get/GetSubjectWithQuestionsCount'),
    createSubject: subject => request('/Subject/Create/Subject', { method: 'POST', body: subjectModel(subject) }),
    updateSubject: subject => request('/Subject/Update/Subject', { method: 'PUT', body: subjectModel(subject) }),
    deleteSubject: id => request('/Subject/Delete/Subject', { method: 'PUT', body: id }),

    getQuestionsPage: (page, pageSize, idSubject) => request('/Question/Get/QuestionWithAnswers/Page', { query: { Page: page, PageSize: pageSize, IdSubject: idSubject } }),
    getRandomQuestions: (total, idSubject) => request('/Question/Get/RandomQuestions', { query: { TotalQuestions: total, IdSubject: idSubject } }),
    createQuestion: question => request('/Question/Create/QuestionWithOptions', { method: 'POST', body: questionModel(question) }),
    updateQuestion: question => request('/Question/Update/QuestionAndOptions', { method: 'PUT', body: questionModel(question) }),
    deleteQuestion: id => request('/Question/Delete/Question', { method: 'PUT', query: { Id: id } }),

    getGeneralProgress: id => request(`/Score/Get/GeneralProgress/${id}`),
    getGlobalProgress: id => request(`/Score/Get/UserGlobalProgress/${id}`),
    getLatestScores: (idUser, page, pageSize) => request('/Score/Get/LastestScores/Page', { query: { IdUser: idUser, Page: page, PageSize: pageSize } }),
    createScore: score => request('/Score/Create/Score', { method: 'POST', body: scoreModel(score) })
}

// ---------------------------------------------------------------------
// Componentes de interfaz
// ---------------------------------------------------------------------
const TOAST_ICONS = { success: '✔', error: '✖', warning: '!', info: 'i' }

function toast(message, type = 'info', { details = [], persistent = false, duration = 0 } = {}) {
    const el = document.createElement('div')
    const extra = details.filter(d => d && d !== message)
    el.className = `toast toast-${type}`
    el.setAttribute('role', type === 'error' ? 'alert' : 'status')
    el.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${TOAST_ICONS[type] || ''}</span>
        <div class="toast-body">
            <p>${esc(message)}</p>
            ${extra.length ? `<ul>${extra.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        </div>
        <button type="button" class="toast-close" aria-label="Cerrar">×</button>`
    el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el))
    toasts.appendChild(el)
    while (toasts.children.length > 4) toasts.firstElementChild.remove()
    if (!persistent) setTimeout(() => dismissToast(el), duration || (type === 'error' ? 7000 : 4500))
    return el
}

function dismissToast(el) {
    if (!el || !el.isConnected) return
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 200)
}

function confirmDialog({ title, html, confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false }) {
    return new Promise(resolve => {
        if (dialog.open) dialog.close()
        dialog.innerHTML = `
            <form method="dialog" class="dialog-body">
                <h3>${esc(title)}</h3>
                <p>${html}</p>
                <div class="dialog-actions">
                    <button value="cancel" class="btn btn-ghost">${esc(cancelText)}</button>
                    <button value="ok" class="btn ${danger ? 'btn-delete' : 'btn-primary'}">${esc(confirmText)}</button>
                </div>
            </form>`
        dialog.returnValue = ''
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true })
        dialog.showModal()
        dialog.querySelector('button[value="ok"]').focus()
    })
}

function field({ label, name, type = 'text', value = '', placeholder = '', autocomplete = 'off', textarea = false, attrs = '' }) {
    const control = textarea
        ? `<textarea name="${name}" rows="2" placeholder="${esc(placeholder)}" ${attrs}>${esc(value)}</textarea>`
        : `<input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="${autocomplete}" ${attrs}>`
    return `
        <div class="field-wrap" data-field="${name}">
            <label class="field"><span class="field-label">${esc(label)}</span>${control}</label>
            <small class="field-error"></small>
        </div>`
}

function selectOptions(options, value = '', placeholder = null) {
    const first = placeholder !== null ? `<option value="">${esc(placeholder)}</option>` : ''
    return first + options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
}

function selectField({ label, name, options = [], value = '', placeholder = null, attrs = '' }) {
    return `
        <div class="field-wrap" data-field="${name}">
            <label class="field"><span class="field-label">${esc(label)}</span><select name="${name}" ${attrs}>${selectOptions(options, value, placeholder)}</select></label>
            <small class="field-error"></small>
        </div>`
}

function crudActions() {
    return `
        <div class="actions">
            <button type="button" class="btn btn-add" data-action="add">Agregar</button>
            <button type="button" class="btn btn-edit" data-action="edit" disabled>Editar</button>
            <button type="button" class="btn btn-delete" data-action="delete" disabled>Eliminar</button>
            <button type="button" class="btn btn-clear" data-action="clear">Limpiar</button>
        </div>`
}

function formValue(form, name) {
    const el = form.elements[name]
    return el ? String(el.value).trim() : ''
}

function setValue(form, name, value) {
    const el = form.elements[name]
    if (el) el.value = value ?? ''
}

function setFieldErrors(form, errors) {
    const names = Object.keys(errors).filter(name => errors[name])
    names.forEach(name => {
        const wrap = form.querySelector(`[data-field="${name}"]`)
        if (!wrap) return
        wrap.classList.add('invalid')
        wrap.querySelector('.field-error').textContent = errors[name]
    })
    const first = names.map(name => form.elements[name]).find(el => el && typeof el.focus === 'function')
    if (first) first.focus()
    return names.length > 0
}

function clearFormErrors(form) {
    form.querySelectorAll('.field-wrap.invalid').forEach(wrap => {
        wrap.classList.remove('invalid')
        wrap.querySelector('.field-error').textContent = ''
    })
    const box = form.querySelector('.form-error')
    if (box) {
        box.hidden = true
        box.innerHTML = ''
    }
}

function showFormError(form, err) {
    if (err.fields && Object.keys(err.fields).length) setFieldErrors(form, err.fields)
    const box = form.querySelector('.form-error')
    if (!box) {
        toast(err.message, toastType(err), { details: err.details })
        return
    }
    const extra = (err.details || []).filter(d => d !== err.message)
    box.className = `form-error ${toastType(err)}`
    box.innerHTML = `<strong>${esc(err.message)}</strong>${extra.length ? `<ul>${extra.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`
    box.hidden = false
}

function setActionsMode(form, editing) {
    form.querySelector('[data-action="add"]').disabled = editing
    form.querySelector('[data-action="edit"]').disabled = !editing
    form.querySelector('[data-action="delete"]').disabled = !editing
}

// Botones AGREGAR/EDITAR/ELIMINAR/LIMPIAR; Enter dispara el botón activo (agregar o editar)
function wireActions(form, handlers) {
    form.addEventListener('click', e => {
        const button = e.target.closest('[data-action]')
        if (button && !button.disabled) handlers[button.dataset.action](button)
    })
    form.addEventListener('submit', e => e.preventDefault())
    form.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return
        e.preventDefault()
        const button = form.querySelector('[data-action="add"]:not(:disabled), [data-action="edit"]:not(:disabled)')
        if (button) button.click()
    })
}

// Ejecuta una acción del CRUD bloqueando los botones mientras responde la API
async function runAction(form, button, label, task) {
    const buttons = Array.from(form.querySelectorAll('.actions .btn'))
    const states = buttons.map(b => b.disabled)
    const original = button.innerHTML
    buttons.forEach(b => { b.disabled = true })
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label)}`
    try {
        await task()
    }
    catch (err) {
        handleError(err, { form })
    }
    finally {
        button.innerHTML = original
        buttons.forEach((b, i) => { b.disabled = states[i] })
    }
}

async function withButton(button, label, task) {
    const original = button.innerHTML
    button.disabled = true
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label)}`
    try {
        return await task()
    }
    finally {
        if (button.isConnected) {
            button.innerHTML = original
            button.disabled = false
        }
    }
}

function wireTable(tbody, onSelect, onRetry) {
    tbody.addEventListener('click', e => {
        if (e.target.closest('[data-retry]')) {
            onRetry()
            return
        }
        const row = e.target.closest('tr[data-id]')
        if (row && onSelect) onSelect(row.dataset.id)
    })
    tbody.addEventListener('keydown', e => {
        const row = e.target.closest('tr[data-id]')
        if (row && onSelect && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            onSelect(row.dataset.id)
        }
    })
}

function messageRow(colspan, text, { retry = false, type = '' } = {}) {
    const button = retry ? ' <button type="button" class="btn-link" data-retry>Reintentar</button>' : ''
    return `<tr class="row-message ${type}"><td colspan="${colspan}">${esc(text)}${button}</td></tr>`
}

function loadingRows(colspan, count = 3) {
    return Array.from({ length: count }, () => `<tr class="row-skeleton"><td colspan="${colspan}"><span class="skeleton"></span></td></tr>`).join('')
}

function cardsSkeleton(count, extraClass = '') {
    return Array.from({ length: count }, () => `<div class="card skeleton-card ${extraClass}"><span class="skeleton"></span><span class="skeleton short"></span></div>`).join('')
}

function errorBlock(message) {
    return `<div class="error-block"><p>⚠ ${esc(message)}</p><button type="button" class="btn btn-ghost" data-retry>Reintentar</button></div>`
}

// Paginación: con totalPages (se conoce el total) o con hasNext (la API no da el total)
function pagerHtml({ page, totalPages = null, hasNext = false, pageSize, total = null, sizes = PAGE_SIZES }) {
    const canPrev = page > 1
    const canNext = totalPages !== null ? page < totalPages : hasNext
    const info = total !== null ? plural(total, 'registro', 'registros') : ''
    return `
        <span class="pager-info">${info}</span>
        <div class="pager-controls">
            <button type="button" class="pager-btn" data-page="1" ${canPrev ? '' : 'disabled'} aria-label="Primera página">«</button>
            <button type="button" class="pager-btn" data-page="${page - 1}" ${canPrev ? '' : 'disabled'} aria-label="Página anterior">‹</button>
            <span class="pager-current">Página ${page}${totalPages !== null ? ` de ${totalPages}` : ''}</span>
            <button type="button" class="pager-btn" data-page="${page + 1}" ${canNext ? '' : 'disabled'} aria-label="Página siguiente">›</button>
            ${totalPages !== null ? `<button type="button" class="pager-btn" data-page="${totalPages}" ${canNext ? '' : 'disabled'} aria-label="Última página">»</button>` : ''}
        </div>
        <label class="pager-size">Mostrar<select data-page-size>${sizes.map(s => `<option ${s === pageSize ? 'selected' : ''}>${s}</option>`).join('')}</select></label>`
}

function wirePager(pager, onPage, onSize) {
    pager.addEventListener('click', e => {
        const button = e.target.closest('[data-page]')
        if (button && !button.disabled) onPage(Number(button.dataset.page))
    })
    pager.addEventListener('change', e => {
        if (e.target.matches('[data-page-size]')) onSize(Number(e.target.value))
    })
}

// ---------------------------------------------------------------------
// Conexión, banner sin red y scores pendientes
// ---------------------------------------------------------------------
function noteCacheFallback(cachedAt) {
    cacheNoticeAt = cacheNoticeAt ? Math.min(cacheNoticeAt, cachedAt) : cachedAt
    updateNetBanner()
}

function updateNetBanner() {
    const offline = !navigator.onLine
    if (!offline && !cacheNoticeAt) {
        netBanner.hidden = true
        return
    }
    const status = offline ? 'Sin conexión a internet' : 'No se pudo contactar al servidor'
    const detail = cacheNoticeAt
        ? `mostrando datos guardados el ${formatDateTime(cacheNoticeAt)}`
        : 'se mostrarán los datos guardados en este dispositivo'
    netBanner.textContent = `${status} · ${detail}`
    netBanner.className = 'net-banner' + (offline ? ' offline' : '')
    netBanner.hidden = false
}

function readPending() {
    return readJSON(localStorage, PENDING_KEY, [])
}

function queueScore(payload) {
    const list = readPending()
    list.push({ ...payload, queuedAt: Date.now() })
    writeJSON(localStorage, PENDING_KEY, list)
}

let flushing = false

async function flushPendingScores() {
    const pending = readPending()
    if (flushing || !pending.length || !navigator.onLine || !getSession()) return
    flushing = true
    const remaining = []
    let sent = 0
    for (const item of pending) {
        try {
            await api.createScore(item)
            sent++
        }
        catch (err) {
            if (isConnectionError(err) || err.kind === 'timeout') remaining.push(item)
            else console.warn('Score pendiente rechazado por la API', err)
        }
    }
    // Conserva los que se hayan encolado mientras se enviaban los anteriores
    const added = readPending().filter(item => !pending.some(p => p.queuedAt === item.queuedAt))
    writeJSON(localStorage, PENDING_KEY, remaining.concat(added))
    flushing = false

    if (sent) {
        toast(sent === 1 ? 'Se sincronizó 1 partida jugada sin conexión' : `Se sincronizaron ${sent} partidas jugadas sin conexión`, 'success')
        const last = readJSON(sessionStorage, RESULT_KEY)
        if (last && last.status === 'pending' && !remaining.length) setResultStatus(last.id, 'saved')
        if (parseHash().path === '/inicio') render()
    }
}

// ---------------------------------------------------------------------
// Router (hash) y marco de la app
// ---------------------------------------------------------------------
const routes = {
    '/login': { view: viewLogin, public: true, title: 'Iniciar sesión' },
    '/inicio': { view: viewHome, role: 'USER', title: 'Mi progreso' },
    '/jugar': { view: viewPlay, role: 'USER', title: 'Jugar' },
    '/quiz': { view: viewQuiz, role: 'USER', title: 'Partida', redirect: () => (game && !game.finished ? null : '/jugar') },
    '/resultado': { view: viewResult, role: 'USER', title: 'Resultado', redirect: () => (readJSON(sessionStorage, RESULT_KEY) ? null : '/inicio') },
    '/admin/usuarios': { view: viewUsers, role: 'ADMIN', title: 'Usuarios' },
    '/admin/materias': { view: viewSubjects, role: 'ADMIN', title: 'Materias' },
    '/admin/preguntas': { view: viewQuestions, role: 'ADMIN', title: 'Preguntas' }
}

function parseHash() {
    const hash = location.hash.replace(/^#/, '') || '/'
    const parts = hash.split('?')
    return { path: parts[0], query: Object.fromEntries(new URLSearchParams(parts[1] || '')) }
}

function navigate(path, { replace = false } = {}) {
    if (replace) {
        history.replaceState(null, '', '#' + path)
        render()
    }
    else if (location.hash === '#' + path) {
        render()
    }
    else {
        location.hash = path
    }
}

function render() {
    cleanups.forEach(fn => {
        try { fn() } catch (e) { console.error(e) }
    })
    cleanups = []

    const { path, query } = parseHash()
    const session = getSession()
    const route = routes[path]

    if (sessionExpired) {
        sessionExpired = false
        toast('Tu sesión expiró, vuelve a iniciar sesión', 'warning')
    }
    if (!route) return navigate(session ? homeFor(session) : '/login', { replace: true })
    if (!route.public && !session) return navigate('/login', { replace: true })
    if (route.public && session) return navigate(homeFor(session), { replace: true })
    if (route.role && session.role !== route.role) return navigate(homeFor(session), { replace: true })
    const redirect = route.redirect && route.redirect()
    if (redirect) return navigate(redirect, { replace: true })

    const id = ++renderId
    cacheNoticeAt = null
    updateNetBanner()
    updateChrome(path, session)
    document.title = `${route.title} · Trivia UTS`

    app.innerHTML = ''
    route.view({
        el: app,
        query,
        session,
        isCurrent: () => id === renderId,
        onLeave: fn => cleanups.push(fn)
    })
    window.scrollTo(0, 0)
}

function updateChrome(path, session) {
    const loggedIn = !!session
    document.body.classList.toggle('is-login', !loggedIn)
    userChip.hidden = !loggedIn
    btnLogout.hidden = !loggedIn
    tabsNav.hidden = !loggedIn
    if (!loggedIn) {
        tabsNav.innerHTML = ''
        return
    }

    userChip.innerHTML = `
        <span class="user-name">${esc(session.name || session.userName)}</span>
        <span class="user-role">${session.role === 'ADMIN' ? 'Administrador' : 'Jugador'}</span>`
    tabsNav.innerHTML = (TABS[session.role] || TABS.USER).map(tab => {
        const active = tab.path === path || (tab.also || []).includes(path)
        return `<a href="#${tab.path}" class="tab ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}><span aria-hidden="true">${tab.icon}</span>${esc(tab.label)}</a>`
    }).join('')
}

function isGameInProgress() {
    return !!(game && !game.finished)
}

function confirmAbandon() {
    return confirmDialog({
        title: 'Abandonar partida',
        html: 'Si sales ahora la partida no se guardará en tu progreso.',
        confirmText: 'Abandonar',
        cancelText: 'Seguir jugando',
        danger: true
    })
}

// ---------------------------------------------------------------------
// Vista: login
// ---------------------------------------------------------------------
function viewLogin(ctx) {
    ctx.el.innerHTML = `
        <section class="login">
            <div class="card login-card">
                <img class="login-logo" src="icon-192.png" alt="" width="76" height="76">
                <h1 class="login-title">TRIVIA UTS</h1>
                <p class="muted">Inicia sesión con el usuario que te asignó el administrador</p>
                <form class="form" novalidate>
                    ${field({ label: 'Usuario', name: 'userName', autocomplete: 'username' })}
                    <div class="field-group">
                        ${field({ label: 'Contraseña', name: 'password', type: 'password', autocomplete: 'current-password' })}
                        <button type="button" class="pw-toggle" aria-pressed="false">Mostrar</button>
                    </div>
                    <div class="form-error" role="alert" hidden></div>
                    <button type="submit" class="btn btn-primary btn-block btn-lg">Iniciar sesión</button>
                </form>
            </div>
        </section>`

    const form = ctx.el.querySelector('form')
    const submit = form.querySelector('[type="submit"]')
    const toggle = form.querySelector('.pw-toggle')
    form.elements.userName.focus()

    toggle.addEventListener('click', () => {
        const input = form.elements.password
        const show = input.type === 'password'
        input.type = show ? 'text' : 'password'
        toggle.textContent = show ? 'Ocultar' : 'Mostrar'
        toggle.setAttribute('aria-pressed', String(show))
    })

    form.addEventListener('submit', async e => {
        e.preventDefault()
        clearFormErrors(form)
        const userName = formValue(form, 'userName')
        const password = form.elements.password.value
        const invalid = setFieldErrors(form, {
            userName: !userName && 'Escribe tu usuario',
            password: !password && 'Escribe tu contraseña'
        })
        if (invalid) return
        if (!navigator.onLine) {
            showFormError(form, new ApiError('Necesitas conexión a internet para iniciar sesión', { kind: 'offline' }))
            return
        }

        await withButton(submit, 'Ingresando…', async () => {
            try {
                const { token } = await api.login(userName, password)
                const session = await buildSession(token)
                saveSession(session)
                toast(`¡Hola, ${session.name || session.userName}!`, 'success')
                navigate(homeFor(session))
                flushPendingScores()
            }
            catch (err) {
                handleError(err, { form })
            }
        })
    })
}

// ---------------------------------------------------------------------
// Vista: administrador · usuarios
// ---------------------------------------------------------------------
function viewUsers(ctx) {
    const state = { users: [], page: 1, pageSize: 5, search: '', selected: null }

    ctx.el.innerHTML = `
        <section class="page">
            <h2 class="page-title">Gestión de Usuarios</h2>
            <form class="card form" novalidate>
                <div class="grid-2">
                    ${field({ label: 'Nombre', name: 'name' })}
                    ${field({ label: 'Usuario', name: 'userName' })}
                    ${field({ label: 'Contraseña', name: 'password', type: 'password', autocomplete: 'new-password' })}
                    ${selectField({ label: 'Rol', name: 'rol', options: ROLE_OPTIONS, value: 0 })}
                </div>
                <p class="hint" data-hint hidden></p>
                <div class="form-error" role="alert" hidden></div>
                ${crudActions()}
            </form>
            <div class="card table-card">
                <div class="table-toolbar">
                    <input class="search" type="search" placeholder="Buscar por nombre o usuario" aria-label="Buscar usuarios">
                </div>
                <div class="table-wrap">
                    <table class="table">
                        <thead><tr><th>ID</th><th>Nombre</th><th>Usuario</th><th>Rol</th></tr></thead>
                        <tbody></tbody>
                    </table>
                </div>
                <div class="pager"></div>
            </div>
        </section>`

    const root = ctx.el.firstElementChild
    const form = root.querySelector('form')
    const tbody = root.querySelector('tbody')
    const pager = root.querySelector('.pager')
    const hint = root.querySelector('[data-hint]')
    const search = root.querySelector('.search')

    function updateHint() {
        if (!state.selected) {
            hint.hidden = true
            return
        }
        const userName = formValue(form, 'userName') || state.selected.userName
        hint.innerHTML = `Al editar, la contraseña de este usuario se restablece a <strong>${esc(userName)}123</strong>.`
        hint.hidden = false
    }

    function syncMode() {
        const editing = !!state.selected
        setActionsMode(form, editing)
        const password = form.elements.password
        password.disabled = editing
        password.placeholder = editing ? 'Se restablece al editar' : ''
        if (editing) password.value = ''
        updateHint()
    }

    function reset() {
        state.selected = null
        form.reset()
        clearFormErrors(form)
        syncMode()
        renderTable()
    }

    function select(id) {
        const user = state.users.find(u => u.id === id)
        if (!user || (state.selected && state.selected.id === id)) {
            reset()
            return
        }
        state.selected = user
        clearFormErrors(form)
        setValue(form, 'name', user.name)
        setValue(form, 'userName', user.userName)
        setValue(form, 'rol', user.rol)
        syncMode()
        renderTable()
        form.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    function filtered() {
        const term = state.search.toLowerCase()
        return state.users.filter(u => !term || `${u.name} ${u.userName}`.toLowerCase().includes(term))
    }

    function renderTable() {
        const list = filtered()
        const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize))
        state.page = Math.min(state.page, totalPages)
        const rows = list.slice((state.page - 1) * state.pageSize, state.page * state.pageSize)
        tbody.innerHTML = rows.length
            ? rows.map(u => `
                <tr data-id="${esc(u.id)}" tabindex="0" class="${state.selected && state.selected.id === u.id ? 'selected' : ''}">
                    <td class="cell-id">${esc(shortId(u.id))}</td>
                    <td>${esc(u.name)}</td>
                    <td class="cell-muted">${esc(u.userName)}</td>
                    <td><span class="badge ${u.rol === 1 ? 'badge-admin' : ''}">${u.rol === 1 ? 'Admin' : 'Jugador'}</span></td>
                </tr>`).join('')
            : messageRow(4, state.search ? 'Ningún usuario coincide con la búsqueda' : 'No hay usuarios registrados')
        pager.innerHTML = pagerHtml({ page: state.page, totalPages, pageSize: state.pageSize, total: list.length })
    }

    async function load() {
        tbody.innerHTML = loadingRows(4)
        pager.innerHTML = ''
        try {
            const users = await api.getUsers()
            if (!ctx.isCurrent()) return
            state.users = (users || []).slice().sort(byName)
            if (state.selected) state.selected = state.users.find(u => u.id === state.selected.id) || null
            renderTable()
        }
        catch (err) {
            if (!ctx.isCurrent()) return
            tbody.innerHTML = messageRow(4, err.message, { retry: true, type: 'error' })
            handleError(err, { quiet: true })
        }
    }

    function readForm() {
        return {
            id: state.selected ? state.selected.id : EMPTY_GUID,
            name: formValue(form, 'name'),
            userName: formValue(form, 'userName'),
            password: form.elements.password.value,
            rol: Number(form.elements.rol.value)
        }
    }

    function validate(data, isNew) {
        return {
            name: !data.name && 'El nombre es requerido',
            userName: !data.userName && 'El usuario es requerido',
            password: isNew && !data.password && 'La contraseña es requerida'
        }
    }

    async function add(button) {
        clearFormErrors(form)
        const data = readForm()
        if (setFieldErrors(form, validate(data, true))) return
        await runAction(form, button, 'Guardando…', async () => {
            await api.createUser(data)
            toast(`Usuario "${data.userName}" creado`, 'success')
            reset()
            await load()
        })
        syncMode()
    }

    async function edit(button) {
        if (!state.selected) return
        clearFormErrors(form)
        const data = readForm()
        if (setFieldErrors(form, validate(data, false))) return
        const ok = await confirmDialog({
            title: 'Actualizar usuario',
            html: `Se guardarán los cambios de <strong>${esc(data.userName)}</strong> y su contraseña se restablecerá a <strong>${esc(data.userName)}123</strong>.`,
            confirmText: 'Actualizar'
        })
        if (!ok) return

        const session = getSession()
        await runAction(form, button, 'Actualizando…', async () => {
            await api.updateUser({ id: data.id, name: data.name, userName: data.userName, rol: data.rol })
            toast(`Usuario actualizado. Nueva contraseña: ${data.userName}123`, 'success', { duration: 8000 })
            if (session && data.id === session.id) {
                if (data.rol !== 1) {
                    await logout('Cambiaste tu propio rol; vuelve a iniciar sesión')
                    return
                }
                saveSession({ ...session, userName: data.userName, name: data.name })
                updateChrome(parseHash().path, getSession())
            }
            reset()
            await load()
        })
        if (ctx.isCurrent()) syncMode()
    }

    async function remove(button) {
        const user = state.selected
        if (!user) return
        const session = getSession()
        if (session && user.id === session.id) {
            toast('No puedes eliminar tu propia cuenta', 'warning')
            return
        }
        const ok = await confirmDialog({
            title: 'Eliminar usuario',
            html: `¿Eliminar a <strong>${esc(user.name)}</strong> (${esc(user.userName)})?`,
            confirmText: 'Eliminar',
            danger: true
        })
        if (!ok) return
        await runAction(form, button, 'Eliminando…', async () => {
            await api.deleteUser(user.id)
            toast(`Usuario "${user.userName}" eliminado`, 'success')
            reset()
            await load()
        })
        syncMode()
    }

    wireActions(form, { add, edit, delete: remove, clear: reset })
    wireTable(tbody, select, load)
    wirePager(pager,
        page => { state.page = page; renderTable() },
        size => { state.pageSize = size; state.page = 1; renderTable() })
    search.addEventListener('input', () => {
        state.search = search.value.trim()
        state.page = 1
        renderTable()
    })
    form.elements.userName.addEventListener('input', updateHint)

    syncMode()
    load()
}

// ---------------------------------------------------------------------
// Vista: administrador · materias
// ---------------------------------------------------------------------
function viewSubjects(ctx) {
    const state = { subjects: [], page: 1, pageSize: 5, search: '', selected: null }

    ctx.el.innerHTML = `
        <section class="page">
            <h2 class="page-title">Gestión de Materias</h2>
            <form class="card form" novalidate>
                ${field({ label: 'Nombre de la materia', name: 'name' })}
                ${field({ label: 'Descripción', name: 'description', textarea: true })}
                <p class="hint" data-hint hidden>La descripción guardada no se puede consultar: escribe la descripción que quedará registrada al editar.</p>
                <div class="form-error" role="alert" hidden></div>
                ${crudActions()}
            </form>
            <div class="card table-card">
                <div class="table-toolbar">
                    <input class="search" type="search" placeholder="Buscar materia" aria-label="Buscar materias">
                </div>
                <div class="table-wrap">
                    <table class="table">
                        <thead><tr><th>ID</th><th>Materia</th><th class="cell-center">Preguntas</th></tr></thead>
                        <tbody></tbody>
                    </table>
                </div>
                <div class="pager"></div>
            </div>
        </section>`

    const root = ctx.el.firstElementChild
    const form = root.querySelector('form')
    const tbody = root.querySelector('tbody')
    const pager = root.querySelector('.pager')
    const hint = root.querySelector('[data-hint]')
    const search = root.querySelector('.search')

    function syncMode() {
        setActionsMode(form, !!state.selected)
        hint.hidden = !state.selected
        form.elements.description.placeholder = state.selected ? 'Escribe la descripción de la materia' : ''
    }

    function reset() {
        state.selected = null
        form.reset()
        clearFormErrors(form)
        syncMode()
        renderTable()
    }

    function select(id) {
        const subject = state.subjects.find(s => s.id === id)
        if (!subject || (state.selected && state.selected.id === id)) {
            reset()
            return
        }
        state.selected = subject
        clearFormErrors(form)
        setValue(form, 'name', subject.name)
        setValue(form, 'description', subject.description || '')
        syncMode()
        renderTable()
        form.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    function renderTable() {
        const term = state.search.toLowerCase()
        const list = state.subjects.filter(s => !term || String(s.name).toLowerCase().includes(term))
        const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize))
        state.page = Math.min(state.page, totalPages)
        const rows = list.slice((state.page - 1) * state.pageSize, state.page * state.pageSize)
        tbody.innerHTML = rows.length
            ? rows.map(s => `
                <tr data-id="${esc(s.id)}" tabindex="0" class="${state.selected && state.selected.id === s.id ? 'selected' : ''}">
                    <td class="cell-id">${esc(shortId(s.id))}</td>
                    <td>${iconFor(s.name)} ${esc(s.name)}</td>
                    <td class="cell-center"><span class="badge">${formatNumber(s.totalQuestions)}</span></td>
                </tr>`).join('')
            : messageRow(3, state.search ? 'Ninguna materia coincide con la búsqueda' : 'No hay materias registradas')
        pager.innerHTML = pagerHtml({ page: state.page, totalPages, pageSize: state.pageSize, total: list.length })
    }

    async function load() {
        tbody.innerHTML = loadingRows(3)
        pager.innerHTML = ''
        try {
            const [subjects, counts] = await Promise.all([api.getSubjects(), api.getSubjectsCount()])
            if (!ctx.isCurrent()) return
            const totals = Object.fromEntries((counts || []).map(c => [c.id, c.totalQuestions]))
            state.subjects = (subjects || []).map(s => ({ ...s, totalQuestions: totals[s.id] || 0 })).sort(byName)
            if (state.selected) state.selected = state.subjects.find(s => s.id === state.selected.id) || null
            renderTable()
        }
        catch (err) {
            if (!ctx.isCurrent()) return
            tbody.innerHTML = messageRow(3, err.message, { retry: true, type: 'error' })
            handleError(err, { quiet: true })
        }
    }

    function readForm() {
        return { id: state.selected ? state.selected.id : null, name: formValue(form, 'name'), description: formValue(form, 'description') }
    }

    function validate(data) {
        const duplicated = state.subjects.some(s => s.id !== data.id && String(s.name).trim().toLowerCase() === data.name.toLowerCase())
        return {
            name: !data.name ? 'El nombre de la materia es requerido' : duplicated ? 'Ya existe una materia con ese nombre' : '',
            description: !data.description && 'La descripción de la materia es requerida'
        }
    }

    async function add(button) {
        clearFormErrors(form)
        const data = readForm()
        if (setFieldErrors(form, validate(data))) return
        await runAction(form, button, 'Guardando…', async () => {
            await api.createSubject(data)
            toast(`Materia "${data.name}" creada`, 'success')
            reset()
            await load()
        })
        syncMode()
    }

    async function edit(button) {
        if (!state.selected) return
        clearFormErrors(form)
        const data = readForm()
        if (setFieldErrors(form, validate(data))) return
        await runAction(form, button, 'Actualizando…', async () => {
            await api.updateSubject(data)
            toast(`Materia "${data.name}" actualizada`, 'success')
            reset()
            await load()
        })
        syncMode()
    }

    async function remove(button) {
        const subject = state.selected
        if (!subject) return
        const extra = subject.totalQuestions
            ? ` También se eliminarán sus <strong>${plural(subject.totalQuestions, 'pregunta', 'preguntas')}</strong>.`
            : ''
        const ok = await confirmDialog({
            title: 'Eliminar materia',
            html: `¿Eliminar la materia <strong>${esc(subject.name)}</strong>?${extra}`,
            confirmText: 'Eliminar',
            danger: true
        })
        if (!ok) return
        await runAction(form, button, 'Eliminando…', async () => {
            await api.deleteSubject(subject.id)
            toast(`Materia "${subject.name}" eliminada`, 'success')
            reset()
            await load()
        })
        syncMode()
    }

    wireActions(form, { add, edit, delete: remove, clear: reset })
    wireTable(tbody, select, load)
    wirePager(pager,
        page => { state.page = page; renderTable() },
        size => { state.pageSize = size; state.page = 1; renderTable() })
    search.addEventListener('input', () => {
        state.search = search.value.trim()
        state.page = 1
        renderTable()
    })

    syncMode()
    load()
}

// ---------------------------------------------------------------------
// Vista: administrador · preguntas y respuestas
// ---------------------------------------------------------------------
function viewQuestions(ctx) {
    const state = { subjects: [], counts: {}, filter: '', page: 1, pageSize: 5, rows: [], selected: null }

    ctx.el.innerHTML = `
        <section class="page">
            <h2 class="page-title">Gestión de Preguntas</h2>
            <form class="card form" novalidate>
                ${field({ label: 'Texto de la pregunta', name: 'question' })}
                <div class="question-meta">
                    <div data-subject-select>${selectField({ label: 'Materia', name: 'idSubject', placeholder: 'Cargando materias…' })}</div>
                    <fieldset class="field-wrap answer-picker" data-field="answer">
                        <legend>Respuesta correcta</legend>
                        <div class="answer-options">
                            ${LETTERS.map((letter, i) => `<label class="radio"><input type="radio" name="answer" value="${i}"><span>${letter}</span></label>`).join('')}
                        </div>
                        <small class="field-error"></small>
                    </fieldset>
                </div>
                <div class="grid-2">
                    ${LETTERS.map((letter, i) => field({ label: `Opción ${letter}`, name: `option${i}` })).join('')}
                </div>
                <p class="hint" data-hint hidden>La materia de una pregunta no se puede cambiar al editarla.</p>
                <div class="form-error" role="alert" hidden></div>
                ${crudActions()}
            </form>
            <div class="card table-card">
                <div class="table-toolbar">
                    <select class="filter" aria-label="Filtrar por materia"><option value="">Todas las materias</option></select>
                </div>
                <div class="table-wrap">
                    <table class="table">
                        <thead><tr><th>ID</th><th>Pregunta</th><th>Cat</th><th class="cell-center">Opc</th><th class="cell-center">Res</th></tr></thead>
                        <tbody></tbody>
                    </table>
                </div>
                <div class="pager"></div>
            </div>
        </section>`

    const root = ctx.el.firstElementChild
    const form = root.querySelector('form')
    const tbody = root.querySelector('tbody')
    const pager = root.querySelector('.pager')
    const hint = root.querySelector('[data-hint]')
    const filter = root.querySelector('.filter')
    const subjectSlot = root.querySelector('[data-subject-select]')

    function subjectOptions() {
        return state.subjects.map(s => ({ value: s.id, label: s.name }))
    }

    function renderSubjectControls() {
        const current = formValue(form, 'idSubject')
        subjectSlot.innerHTML = selectField({ label: 'Materia', name: 'idSubject', options: subjectOptions(), value: current, placeholder: 'Selecciona una materia' })
        filter.innerHTML = selectOptions(subjectOptions(), state.filter, 'Todas las materias')
        syncMode()
    }

    function highlightAnswer() {
        const checked = form.querySelector('input[name="answer"]:checked')
        LETTERS.forEach((_, i) => {
            const wrap = form.querySelector(`[data-field="option${i}"] .field`)
            wrap.classList.toggle('is-answer', !!checked && Number(checked.value) === i)
        })
    }

    function syncMode() {
        const editing = !!state.selected
        setActionsMode(form, editing)
        form.elements.idSubject.disabled = editing
        hint.hidden = !editing
    }

    function reset() {
        state.selected = null
        form.reset()
        clearFormErrors(form)
        syncMode()
        highlightAnswer()
        renderTable()
    }

    function select(id) {
        const row = state.rows.find(q => q.id === id)
        if (!row || (state.selected && state.selected.id === id)) {
            reset()
            return
        }
        // La página no trae idSubject, se obtiene por el nombre (la BD no permite materias repetidas)
        const subject = state.subjects.find(s => s.name === row.subjectName)
        const options = (row.options || []).slice(0, LETTERS.length)
        state.selected = { ...row, idSubject: subject ? subject.id : null, options }

        clearFormErrors(form)
        setValue(form, 'question', row.question)
        setValue(form, 'idSubject', state.selected.idSubject || '')
        LETTERS.forEach((_, i) => setValue(form, `option${i}`, options[i] ? options[i].option : ''))
        const answer = options.findIndex(o => o.isAnswer)
        form.querySelectorAll('input[name="answer"]').forEach(radio => {
            radio.checked = Number(radio.value) === answer
        })
        syncMode()
        highlightAnswer()
        renderTable()
        form.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    function totalQuestions() {
        if (state.filter) return state.counts[state.filter] || 0
        return Object.values(state.counts).reduce((sum, n) => sum + n, 0)
    }

    function renderTable() {
        const total = totalQuestions()
        const totalPages = Math.max(1, Math.ceil(total / state.pageSize))
        tbody.innerHTML = state.rows.length
            ? state.rows.map(q => {
                const options = q.options || []
                const answer = options.findIndex(o => o.isAnswer)
                return `
                    <tr data-id="${esc(q.id)}" tabindex="0" class="${state.selected && state.selected.id === q.id ? 'selected' : ''}">
                        <td class="cell-id">${esc(shortId(q.id))}</td>
                        <td>${esc(q.question)}</td>
                        <td class="cell-tag">${esc(q.subjectName)}</td>
                        <td class="cell-options">${options.map(o => esc(o.option)).join(' | ')}</td>
                        <td class="cell-answer">${LETTERS[answer] || '—'}</td>
                    </tr>`
            }).join('')
            : messageRow(5, state.filter ? 'Esta materia no tiene preguntas' : 'No hay preguntas registradas')
        pager.innerHTML = pagerHtml({ page: state.page, totalPages, pageSize: state.pageSize, total })
    }

    async function loadPage() {
        tbody.innerHTML = loadingRows(5)
        try {
            const rows = await api.getQuestionsPage(state.page, state.pageSize, state.filter || null)
            if (!ctx.isCurrent()) return
            state.rows = rows || []
            // Tras eliminar la última pregunta de una página se regresa a la anterior
            if (!state.rows.length && state.page > 1) {
                state.page--
                await loadPage()
                return
            }
            if (state.selected) {
                const fresh = state.rows.find(q => q.id === state.selected.id)
                if (!fresh) state.selected = null
            }
            renderTable()
        }
        catch (err) {
            if (!ctx.isCurrent()) return
            tbody.innerHTML = messageRow(5, err.message, { retry: true, type: 'error' })
            handleError(err, { quiet: true })
        }
    }

    async function loadCounts() {
        const [subjects, counts] = await Promise.all([api.getSubjects(), api.getSubjectsCount()])
        state.subjects = (subjects || []).slice().sort(byName)
        state.counts = Object.fromEntries((counts || []).map(c => [c.id, c.totalQuestions]))
    }

    async function load() {
        tbody.innerHTML = loadingRows(5)
        pager.innerHTML = ''
        try {
            await loadCounts()
        }
        catch (err) {
            if (!ctx.isCurrent()) return
            tbody.innerHTML = messageRow(5, err.message, { retry: true, type: 'error' })
            handleError(err, { quiet: true })
            return
        }
        if (!ctx.isCurrent()) return
        renderSubjectControls()
        await loadPage()
    }

    function readForm() {
        const checked = form.querySelector('input[name="answer"]:checked')
        return {
            question: formValue(form, 'question'),
            idSubject: formValue(form, 'idSubject'),
            options: LETTERS.map((_, i) => formValue(form, `option${i}`)),
            answer: checked ? Number(checked.value) : null
        }
    }

    function validate(data, isNew) {
        const errors = {
            question: !data.question && 'Escribe el texto de la pregunta',
            idSubject: isNew && !data.idSubject && 'Selecciona la materia',
            answer: data.answer === null && 'Marca cuál opción es la correcta'
        }
        const seen = []
        data.options.forEach((option, i) => {
            const key = option.toLowerCase()
            if (!option) errors[`option${i}`] = 'La opción es requerida'
            else if (seen.includes(key)) errors[`option${i}`] = 'Opción repetida'
            seen.push(key)
        })
        return errors
    }

    async function add(button) {
        clearFormErrors(form)
        const data = readForm()
        if (setFieldErrors(form, validate(data, true))) return
        await runAction(form, button, 'Guardando…', async () => {
            await api.createQuestion({
                question: data.question,
                idSubject: data.idSubject,
                options: data.options.map((option, i) => ({ option, isAnswer: i === data.answer }))
            })
            toast('Pregunta creada', 'success')
            reset()
            await loadCounts()
            renderSubjectControls()
            await loadPage()
        })
        syncMode()
    }

    async function edit(button) {
        const selected = state.selected
        if (!selected) return
        clearFormErrors(form)
        const data = readForm()
        if (setFieldErrors(form, validate(data, false))) return
        await runAction(form, button, 'Actualizando…', async () => {
            await api.updateQuestion({
                id: selected.id,
                question: data.question,
                idSubject: selected.idSubject,
                options: data.options.map((option, i) => ({
                    id: selected.options[i] ? selected.options[i].id : null,
                    option,
                    isAnswer: i === data.answer
                }))
            })
            toast('Pregunta actualizada', 'success')
            reset()
            await loadPage()
        })
        syncMode()
    }

    async function remove(button) {
        const selected = state.selected
        if (!selected) return
        const ok = await confirmDialog({
            title: 'Eliminar pregunta',
            html: `¿Eliminar la pregunta <strong>${esc(selected.question)}</strong> y sus respuestas?`,
            confirmText: 'Eliminar',
            danger: true
        })
        if (!ok) return
        await runAction(form, button, 'Eliminando…', async () => {
            await api.deleteQuestion(selected.id)
            toast('Pregunta eliminada', 'success')
            reset()
            await loadCounts()
            await loadPage()
        })
        syncMode()
    }

    wireActions(form, { add, edit, delete: remove, clear: reset })
    wireTable(tbody, select, load)
    wirePager(pager,
        page => { state.page = page; loadPage() },
        size => { state.pageSize = size; state.page = 1; loadPage() })
    form.addEventListener('change', e => {
        if (e.target.name === 'answer') highlightAnswer()
    })
    filter.addEventListener('change', () => {
        state.filter = filter.value
        state.page = 1
        reset()
        loadPage()
    })

    syncMode()
    load()
}

// ---------------------------------------------------------------------
// Vista: jugador · mi progreso
// ---------------------------------------------------------------------
function viewHome(ctx) {
    const session = ctx.session
    const state = { page: 1, pageSize: 5 }
    const pending = readPending().filter(p => p.idUser === session.id).length

    ctx.el.innerHTML = `
        <section class="page">
            <div class="card hero">
                <div>
                    <p class="eyebrow">Hola,</p>
                    <h2 class="hero-name">${esc(session.name || session.userName)}</h2>
                    <p class="muted">Este es tu progreso en la trivia.</p>
                </div>
                <a class="btn btn-primary btn-lg" href="#/jugar">🎮 Jugar ahora</a>
            </div>
            ${pending ? `<div class="notice">📶 Tienes ${plural(pending, 'partida', 'partidas')} sin sincronizar. Se enviarán al recuperar la conexión.</div>` : ''}
            <div class="stats" data-stats>${cardsSkeleton(5)}</div>
            <h3 class="section-title">Score por materia</h3>
            <div class="subject-grid" data-subjects>${cardsSkeleton(3)}</div>
            <h3 class="section-title">Últimos scores por materia</h3>
            <div class="card table-card">
                <div class="table-wrap">
                    <table class="table">
                        <thead><tr><th>Materia</th><th>Score</th></tr></thead>
                        <tbody></tbody>
                    </table>
                </div>
                <div class="pager"></div>
            </div>
        </section>`

    const root = ctx.el.firstElementChild
    const statsEl = root.querySelector('[data-stats]')
    const subjectsEl = root.querySelector('[data-subjects]')
    const tbody = root.querySelector('tbody')
    const pager = root.querySelector('.pager')

    function renderStats(global, general) {
        const score = Number(global.generalScore || 0)
        statsEl.innerHTML = `
            <div class="card stat stat-main">
                <div class="ring ${levelClass(score)}" style="--value:${score}"><span>${formatScore(score)}%</span></div>
                <div>
                    <p class="stat-label">Score general</p>
                    <p class="muted small">Promedio de todas tus partidas · ${plural(global.subjectsPlayed || 0, 'materia jugada', 'materias jugadas')}</p>
                </div>
            </div>
            <div class="card stat"><p class="stat-value">${formatNumber(general.games)}</p><p class="stat-label">Partidas jugadas</p></div>
            <div class="card stat"><p class="stat-value">${formatNumber(general.points)}</p><p class="stat-label">Puntos totales</p></div>
            <div class="card stat"><p class="stat-value">${formatNumber(global.totalPreguntas)}</p><p class="stat-label">Preguntas acertadas</p></div>
            <div class="card stat"><p class="stat-value">${formatNumber(global.streak)}</p><p class="stat-label">Partidas hoy</p></div>`
    }

    function renderSubjects(subjects) {
        subjectsEl.innerHTML = subjects.length
            ? subjects.slice().sort(byName).map(s => {
                const played = s.gamesPlayed > 0
                const avg = Number(s.averageScore || 0)
                return `
                    <article class="card subject-card">
                        <div class="subject-head">
                            <h4><span aria-hidden="true">${iconFor(s.name)}</span>${esc(s.name)}</h4>
                            <span class="subject-score">${played ? `${formatScore(avg)}%` : '—'}</span>
                        </div>
                        <div class="bar ${levelClass(avg)}"><span style="width:${played ? avg : 0}%"></span></div>
                        <p class="muted small">${played ? `${plural(s.gamesPlayed, 'partida', 'partidas')} · ${formatNumber(s.totalPoints)} pts` : 'Aún no juegas esta materia'}</p>
                        <a class="btn-link" href="#/jugar?materia=${encodeURIComponent(s.id)}">Jugar →</a>
                    </article>`
            }).join('')
            : '<p class="muted">No hay materias disponibles todavía.</p>'
    }

    async function loadProgress() {
        statsEl.innerHTML = cardsSkeleton(5)
        subjectsEl.innerHTML = cardsSkeleton(3)
        try {
            const [global, general] = await Promise.all([api.getGlobalProgress(session.id), api.getGeneralProgress(session.id)])
            if (!ctx.isCurrent()) return
            renderStats(global || {}, general || {})
            renderSubjects((global && global.subjects) || [])
        }
        catch (err) {
            if (!ctx.isCurrent()) return
            statsEl.innerHTML = errorBlock(err.message)
            subjectsEl.innerHTML = ''
            handleError(err, { quiet: true })
        }
    }

    async function loadLatest() {
        tbody.innerHTML = loadingRows(2)
        try {
            const rows = (await api.getLatestScores(session.id, state.page, state.pageSize)) || []
            if (!ctx.isCurrent()) return
            tbody.innerHTML = rows.length
                ? rows.map(row => {
                    const score = row.score || {}
                    const subject = score.subject && score.subject.name
                    const value = Number(score.score || 0)
                    return `
                        <tr>
                            <td>${subject ? `${iconFor(subject)} ${esc(subject)}` : '<span class="badge">🎲 Mixto</span>'}</td>
                            <td class="cell-score">
                                <div class="score-inline">
                                    <div class="bar ${levelClass(value)}"><span style="width:${value}%"></span></div>
                                    <strong>${formatScore(value)}%</strong>
                                </div>
                            </td>
                        </tr>`
                }).join('')
                : messageRow(2, state.page > 1 ? 'No hay más registros' : 'Aún no tienes partidas. ¡Juega la primera!')
            pager.innerHTML = state.page === 1 && !rows.length
                ? ''
                : pagerHtml({ page: state.page, hasNext: rows.length === state.pageSize, pageSize: state.pageSize, sizes: [5, 10] })
        }
        catch (err) {
            if (!ctx.isCurrent()) return
            tbody.innerHTML = messageRow(2, err.message, { retry: true, type: 'error' })
            handleError(err, { quiet: true })
        }
    }

    root.addEventListener('click', e => {
        if (e.target.closest('[data-stats] [data-retry]')) loadProgress()
    })
    wireTable(tbody, null, loadLatest)
    wirePager(pager,
        page => { state.page = page; loadLatest() },
        size => { state.pageSize = size; state.page = 1; loadLatest() })

    loadProgress()
    loadLatest()
}

// ---------------------------------------------------------------------
// Vista: jugador · elegir partida
// ---------------------------------------------------------------------
function countOptions(available) {
    const options = [5, 10, 15, 20].filter(n => n <= available)
    if (available > 0 && available < 20 && !options.includes(available)) options.push(available)
    return options
}

function viewPlay(ctx) {
    const state = { modes: [], selected: ctx.query.materia || 'mixed', total: 10 }

    ctx.el.innerHTML = `
        <section class="page">
            <div>
                <h2 class="page-title">Nueva partida</h2>
                <p class="muted">Elige una materia o juega en modo <strong>mixto</strong> con preguntas de todas.</p>
            </div>
            <div class="mode-grid" data-modes>${cardsSkeleton(4)}</div>
            <h3 class="section-title">Número de preguntas</h3>
            <div class="chips" data-counts></div>
            <p class="muted small">Tienes ${QUESTION_TIME} segundos por pregunta · ${POINTS_PER_ANSWER} puntos por acierto.</p>
            <div class="play-actions"><button type="button" class="btn btn-primary btn-lg" data-start disabled>Comenzar</button></div>
        </section>`

    const root = ctx.el.firstElementChild
    const modesEl = root.querySelector('[data-modes]')
    const countsEl = root.querySelector('[data-counts]')
    const startBtn = root.querySelector('[data-start]')

    function current() {
        return state.modes.find(m => m.id === state.selected)
    }

    function renderModes() {
        modesEl.innerHTML = state.modes.map(m => `
            <button type="button" class="mode-card ${m.id === state.selected ? 'selected' : ''}" data-mode="${esc(m.id)}" aria-pressed="${m.id === state.selected}">
                <span class="mode-icon" aria-hidden="true">${m.icon}</span>
                <span class="mode-name">${esc(m.name)}</span>
                <span class="mode-desc">${esc(m.desc)}</span>
            </button>`).join('')
    }

    function renderCounts() {
        const mode = current()
        const available = mode ? mode.count : 0
        const options = countOptions(available)
        if (!options.includes(state.total)) state.total = options.includes(10) ? 10 : options[options.length - 1]
        countsEl.innerHTML = options.length
            ? options.map(n => `
                <button type="button" class="chip-btn ${n === state.total ? 'selected' : ''}" data-count="${n}" aria-pressed="${n === state.total}">
                    ${n === available && n % 5 !== 0 ? `Todas (${n})` : n}
                </button>`).join('')
            : '<p class="muted">No hay preguntas disponibles para jugar.</p>'
        startBtn.disabled = !options.length
    }

    async function load() {
        modesEl.innerHTML = cardsSkeleton(4)
        try {
            const subjects = (await api.getSubjectsCount()) || []
            if (!ctx.isCurrent()) return
            const playable = subjects.filter(s => s.totalQuestions > 0).sort(byName)
            const total = playable.reduce((sum, s) => sum + s.totalQuestions, 0)
            state.modes = [{ id: 'mixed', name: 'Mixto', icon: '🎲', count: total, desc: `Todas las materias · ${plural(total, 'pregunta', 'preguntas')}` }]
                .concat(playable.map(s => ({ id: s.id, name: s.name, icon: iconFor(s.name), count: s.totalQuestions, desc: plural(s.totalQuestions, 'pregunta', 'preguntas') })))
            if (!current()) {
                if (ctx.query.materia) toast('Esa materia todavía no tiene preguntas; elige otra o juega en modo mixto', 'info')
                state.selected = 'mixed'
            }
            renderModes()
            renderCounts()
        }
        catch (err) {
            if (!ctx.isCurrent()) return
            modesEl.innerHTML = errorBlock(err.message)
            countsEl.innerHTML = ''
            startBtn.disabled = true
            handleError(err, { quiet: true })
        }
    }

    root.addEventListener('click', e => {
        const mode = e.target.closest('[data-mode]')
        const count = e.target.closest('[data-count]')
        if (mode) {
            state.selected = mode.dataset.mode
            renderModes()
            renderCounts()
        }
        if (count) {
            state.total = Number(count.dataset.count)
            renderCounts()
        }
        if (e.target.closest('[data-retry]')) load()
    })

    startBtn.addEventListener('click', () => {
        const mode = current()
        if (!mode) return
        const isMixed = mode.id === 'mixed'
        withButton(startBtn, 'Preparando…', () => startGame({
            isMixed,
            idSubject: isMixed ? null : mode.id,
            subjectName: mode.name,
            total: state.total
        }))
    })

    load()
}

async function startGame(config) {
    let questions
    try {
        questions = await api.getRandomQuestions(config.total, config.idSubject)
    }
    catch (err) {
        handleError(err)
        return false
    }

    const playable = (questions || []).filter(q => Array.isArray(q.options) && q.options.length > 1 && q.options.some(o => o.isAnswer))
    if (!playable.length) {
        toast('No hay preguntas disponibles para esta materia todavía', 'warning')
        return false
    }
    if (!navigator.onLine) toast('Sin conexión: jugarás con preguntas guardadas en este dispositivo', 'info')

    game = {
        config,
        isMixed: config.isMixed,
        idSubject: config.idSubject,
        subjectName: config.subjectName,
        questions: playable.map(q => ({ ...q, options: shuffle(q.options) })),
        index: 0,
        answers: [],
        finished: false
    }
    navigate('/quiz')
    return true
}

// ---------------------------------------------------------------------
// Vista: jugador · partida
// ---------------------------------------------------------------------
function viewQuiz(ctx) {
    let tick = null
    let advance = null
    let locked = false

    ctx.onLeave(() => {
        clearInterval(tick)
        clearTimeout(advance)
        document.removeEventListener('keydown', onKey)
    })
    document.addEventListener('keydown', onKey)
    showQuestion()

    function onKey(e) {
        if (locked || dialog.open || e.ctrlKey || e.metaKey || e.altKey) return
        const key = e.key.toUpperCase()
        let index = LETTERS.indexOf(key)
        if (index < 0) index = ['1', '2', '3', '4'].indexOf(key)
        if (index >= 0 && index < game.questions[game.index].options.length) answer(index)
    }

    function showQuestion() {
        const q = game.questions[game.index]
        const total = game.questions.length
        const hits = game.answers.filter(a => a.isCorrect).length
        const subject = q.subjectName || game.subjectName
        locked = false

        ctx.el.innerHTML = `
            <section class="page quiz">
                <div class="quiz-top">
                    <span class="badge badge-subject">${iconFor(subject)} ${esc(subject)}</span>
                    <span class="quiz-count">Pregunta <strong>${game.index + 1}</strong> de ${total}</span>
                    <span class="quiz-hits" title="Respuestas correctas">✔ ${hits}</span>
                </div>
                <div class="progress" aria-hidden="true"><span style="width:${(game.index / total) * 100}%"></span></div>
                <div class="card quiz-card">
                    <div class="timer" aria-hidden="true">
                        <div class="timer-track"><div class="timer-fill"></div></div>
                        <span class="timer-text">${QUESTION_TIME}s</span>
                    </div>
                    <h2 class="quiz-question">${esc(q.question)}</h2>
                    <div class="quiz-options">
                        ${q.options.map((o, i) => `
                            <button type="button" class="option-btn" data-index="${i}">
                                <span class="option-letter">${LETTERS[i] || i + 1}</span>
                                <span>${esc(o.option)}</span>
                            </button>`).join('')}
                    </div>
                    <p class="quiz-feedback" aria-live="polite"></p>
                </div>
                <div class="quiz-actions">
                    <button type="button" class="btn btn-clear" data-quit>Abandonar partida</button>
                </div>
            </section>`

        const root = ctx.el.firstElementChild
        root.querySelector('.quiz-options').addEventListener('click', e => {
            const button = e.target.closest('[data-index]')
            if (button) answer(Number(button.dataset.index))
        })
        root.querySelector('[data-quit]').addEventListener('click', async () => {
            if (await confirmAbandon()) {
                game = null
                navigate('/jugar')
            }
        })
        startTimer(root)
    }

    function startTimer(root) {
        const deadline = Date.now() + QUESTION_TIME * 1000
        const timer = root.querySelector('.timer')
        const fill = root.querySelector('.timer-fill')
        const text = root.querySelector('.timer-text')
        clearInterval(tick)
        tick = setInterval(() => {
            const left = Math.max(0, deadline - Date.now())
            fill.style.width = `${(left / (QUESTION_TIME * 1000)) * 100}%`
            text.textContent = `${Math.ceil(left / 1000)}s`
            timer.classList.toggle('warn', left <= 8000 && left > 4000)
            timer.classList.toggle('danger', left <= 4000)
            if (left <= 0) answer(null)
        }, 100)
    }

    function answer(index) {
        if (locked) return
        locked = true
        clearInterval(tick)

        const q = game.questions[game.index]
        const correctIndex = q.options.findIndex(o => o.isAnswer)
        const chosen = index === null ? null : q.options[index]
        const isCorrect = !!(chosen && chosen.isAnswer)
        game.answers.push({
            question: q.question,
            chosen: chosen ? chosen.option : null,
            correct: correctIndex >= 0 ? q.options[correctIndex].option : null,
            isCorrect,
            timedOut: index === null
        })

        ctx.el.querySelectorAll('.option-btn').forEach((button, i) => {
            button.disabled = true
            if (i === correctIndex) button.classList.add('correct')
            else if (i === index) button.classList.add('wrong')
        })
        const feedback = ctx.el.querySelector('.quiz-feedback')
        feedback.textContent = isCorrect
            ? `¡Correcto! +${POINTS_PER_ANSWER} pts`
            : index === null ? '⏰ Se acabó el tiempo' : 'Incorrecto'
        feedback.className = `quiz-feedback ${isCorrect ? 'ok' : 'bad'}`
        advance = setTimeout(next, 1500)
    }

    function next() {
        game.index++
        if (game.index < game.questions.length) showQuestion()
        else finishGame()
    }
}

function finishGame() {
    const session = getSession()
    const correct = game.answers.filter(a => a.isCorrect).length
    const total = game.questions.length
    const result = {
        id: Date.now(),
        score: Math.round((correct / total) * 10000) / 100,
        correct,
        total,
        points: correct * POINTS_PER_ANSWER,
        isMixed: game.isMixed,
        idSubject: game.idSubject,
        subjectName: game.subjectName,
        idUser: session ? session.id : null,
        answers: game.answers,
        config: game.config,
        status: 'saving',
        statusMessage: ''
    }
    game.finished = true
    game = null
    writeJSON(sessionStorage, RESULT_KEY, result)
    navigate('/resultado')
    submitScore(result)
}

async function submitScore(result) {
    const payload = { score: result.score, isMixed: result.isMixed, points: result.points, idSubject: result.idSubject, idUser: result.idUser }
    setResultStatus(result.id, 'saving')
    try {
        await api.createScore(payload)
        setResultStatus(result.id, 'saved')
    }
    catch (err) {
        // Sin red se encola y se envía al reconectar; cualquier otro error se muestra con "Reintentar"
        if (isConnectionError(err)) {
            queueScore(payload)
            setResultStatus(result.id, 'pending')
        }
        else {
            setResultStatus(result.id, 'error', err.message)
            handleError(err, { quiet: true })
        }
    }
}

function setResultStatus(id, status, message = '') {
    const result = readJSON(sessionStorage, RESULT_KEY)
    if (!result || result.id !== id) return
    result.status = status
    result.statusMessage = message
    writeJSON(sessionStorage, RESULT_KEY, result)
    const el = document.querySelector('[data-save-status]')
    if (el) {
        el.className = `save-status ${status}`
        el.innerHTML = saveStatusHtml(result)
    }
}

function saveStatusHtml(result) {
    if (result.status === 'saved') return '✔ Score guardado en tu progreso'
    if (result.status === 'pending') return '📶 Sin conexión: el score se enviará automáticamente al reconectar'
    if (result.status === 'error') return `✖ No se pudo guardar el score: ${esc(result.statusMessage)} <button type="button" class="btn-link" data-retry-save>Reintentar</button>`
    return '<span class="spinner" aria-hidden="true"></span> Guardando score…'
}

// ---------------------------------------------------------------------
// Vista: jugador · resultado de la partida
// ---------------------------------------------------------------------
function viewResult(ctx) {
    const result = readJSON(sessionStorage, RESULT_KEY)
    const wrong = result.total - result.correct
    const verdict = result.score >= 90 ? '¡Excelente! 🏆'
        : result.score >= 70 ? '¡Muy bien! 🎉'
        : result.score >= 50 ? 'Bien, puedes mejorar 💪'
        : 'Sigue practicando 📚'
    const subject = result.isMixed ? '🎲 Modo mixto' : `${iconFor(result.subjectName)} ${esc(result.subjectName)}`

    ctx.el.innerHTML = `
        <section class="page result">
            <div class="card result-card">
                <p class="eyebrow">${subject} · ${plural(result.total, 'pregunta', 'preguntas')}</p>
                <div class="ring ring-lg ${levelClass(result.score)}" style="--value:${result.score}"><span>${formatScore(result.score)}%</span></div>
                <h2 class="result-title">${verdict}</h2>
                <div class="result-stats">
                    <div class="result-stat"><strong>${result.correct}</strong><span>Correctas</span></div>
                    <div class="result-stat"><strong>${wrong}</strong><span>Incorrectas</span></div>
                    <div class="result-stat"><strong>${result.points}</strong><span>Puntos</span></div>
                </div>
                <p class="save-status ${result.status}" data-save-status>${saveStatusHtml(result)}</p>
                <div class="result-actions">
                    <button type="button" class="btn btn-primary" data-again>Jugar de nuevo</button>
                    <a class="btn btn-ghost" href="#/jugar">Otra materia</a>
                    <a class="btn btn-ghost" href="#/inicio">Ver mi progreso</a>
                </div>
            </div>
            <h3 class="section-title">Revisión de respuestas</h3>
            <ol class="review">
                ${result.answers.map((a, i) => `
                    <li class="review-item ${a.isCorrect ? 'ok' : 'bad'}">
                        <p class="review-q"><span class="review-num">${i + 1}.</span> ${esc(a.question)}</p>
                        <p class="review-a">${a.isCorrect ? '✔' : '✖'} Tu respuesta: <strong>${a.timedOut ? 'Sin responder (tiempo agotado)' : esc(a.chosen)}</strong></p>
                        ${a.isCorrect ? '' : `<p class="review-a muted">Respuesta correcta: <strong>${esc(a.correct)}</strong></p>`}
                    </li>`).join('')}
            </ol>
        </section>`

    const root = ctx.el.firstElementChild
    root.addEventListener('click', e => {
        const again = e.target.closest('[data-again]')
        if (again) withButton(again, 'Preparando…', () => startGame(result.config))
        if (e.target.closest('[data-retry-save]')) submitScore(readJSON(sessionStorage, RESULT_KEY))
    })
}

// ---------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------
// Durante una partida, salir por cualquier enlace (pestañas, logo) pide confirmación
document.addEventListener('click', async e => {
    const link = e.target.closest('a[href^="#/"]')
    if (!link || !isGameInProgress()) return
    e.preventDefault()
    if (await confirmAbandon()) {
        game = null
        navigate(link.getAttribute('href').slice(1))
    }
})

btnLogout.addEventListener('click', async () => {
    if (isGameInProgress() && !(await confirmAbandon())) return
    logout('Sesión cerrada')
})

btnInstall.addEventListener('click', async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    await installPrompt.userChoice
    installPrompt = null
    btnInstall.hidden = true
})

window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault()
    installPrompt = e
    btnInstall.hidden = false
})

window.addEventListener('appinstalled', () => {
    installPrompt = null
    btnInstall.hidden = true
    toast('Trivia UTS se instaló en tu dispositivo', 'success')
})

window.addEventListener('online', () => {
    updateNetBanner()
    toast('Conexión restablecida', 'success')
    flushPendingScores()
})

window.addEventListener('offline', () => {
    updateNetBanner()
    toast('Sin conexión: verás los datos guardados en este dispositivo', 'warning')
})

window.addEventListener('hashchange', render)

render()
flushPendingScores()

// Comprueba en segundo plano que el token siga siendo válido
if (getSession() && navigator.onLine) {
    api.getSession().catch(err => {
        if (err.status === 401) handleError(err, { quiet: true })
    })
}

async function registerSW() {
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('./sw.js')
        }
        catch (e) {
            console.log('fallo en el registro del service worker', e)
        }
    }
}
