/* ============================================================================
 * Smartschool.js — Client library voor Smartschool Bridge API
 *
 * Alle business logica buiten de UI:
 *   - Auth (login, logout, auto-login via sessionStorage)
 *   - Cijfers (grades)
 *   - Berichten (messages: list, read, send, drafts, attachments)
 *   - Planner (week, todos, create, actions)
 *   - Profiel
 *   - Uploads
 *
 * UI roept enkel methods aan en luistert naar events.
 * ==========================================================================*/

(function (global) {
  'use strict';

  // ==========================================================================
  // CONFIG
  // ==========================================================================
  const DEFAULT_API = 'https://smartschoolbridge.onrender.com';
  const STORAGE_KEY = 'ss_creds';

  // ==========================================================================
  // HELPERS
  // ==========================================================================
  const b64 = s => btoa(unescape(encodeURIComponent(s)));
  const unb64 = s => decodeURIComponent(escape(atob(s)));

  function parseJSON(text) {
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  // ==========================================================================
  // EVENT EMITTER (mini)
  // ==========================================================================
  class Emitter {
    constructor() { this._handlers = {}; }
    on(evt, fn) {
      (this._handlers[evt] = this._handlers[evt] || []).push(fn);
      return () => this.off(evt, fn);
    }
    off(evt, fn) {
      const list = this._handlers[evt];
      if (!list) return;
      this._handlers[evt] = list.filter(f => f !== fn);
    }
    emit(evt, data) {
      const list = this._handlers[evt];
      if (!list) return;
      for (const fn of list) {
        try { fn(data); } catch (e) { console.error('[ss] handler', evt, e); }
      }
    }
  }

  // ==========================================================================
  // HTTP CLIENT
  // ==========================================================================
  class HttpClient {
    constructor(baseURL, credsProvider) {
      this.baseURL = baseURL;
      this.credsProvider = credsProvider;
    }

    async request(path, opts = {}) {
      const headers = {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      };
      const creds = this.credsProvider();
      if (creds) headers['X-SS-Creds'] = b64(JSON.stringify(creds));

      const init = {
        method: opts.method || 'GET',
        headers,
        credentials: 'omit',
      };
      if (opts.body !== undefined) init.body = opts.body;

      const r = await fetch(this.baseURL + path, init);
      const text = await r.text();
      const data = parseJSON(text);
      if (!r.ok) {
        const msg = (data && data.error) || `HTTP ${r.status}`;
        const err = new Error(msg);
        err.status = r.status;
        err.data = data;
        throw err;
      }
      return data;
    }

    /** Download blob (voor attachments) */
    async download(path) {
      const headers = {};
      const creds = this.credsProvider();
      if (creds) headers['X-SS-Creds'] = b64(JSON.stringify(creds));

      const r = await fetch(this.baseURL + path, {
        method: 'GET', headers, credentials: 'omit',
      });
      if (!r.ok) {
        const text = await r.text();
        const data = parseJSON(text);
        throw new Error((data && data.error) || `HTTP ${r.status}`);
      }
      return r.blob();
    }

    /** Multipart upload */
    async upload(path, formData) {
      const headers = {};
      const creds = this.credsProvider();
      if (creds) headers['X-SS-Creds'] = b64(JSON.stringify(creds));

      const r = await fetch(this.baseURL + path, {
        method: 'POST', headers, body: formData, credentials: 'omit',
      });
      const text = await r.text();
      const data = parseJSON(text);
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
      return data;
    }
  }

  // ==========================================================================
  // AUTH MODULE
  // ==========================================================================
  class AuthModule {
    constructor(client, emitter, storageKey) {
      this.client = client;
      this.emitter = emitter;
      this.storageKey = storageKey;
      this._creds = null;
      this._user = null;   // { username, main_url }
    }

    get creds() { return this._creds; }
    get user() { return this._user; }
    get isLoggedIn() { return !!this._creds; }

    /** Login met credentials. Slaat op in sessionStorage. */
    async login(creds) {
      this._creds = {
        username: (creds.username || '').trim(),
        password: creds.password || '',
        main_url: (creds.main_url || '').trim(),
        mfa: (creds.mfa || '').trim(),
      };
      try {
        const d = await this.client.request('/api/auth/login', { method: 'POST' });
        this._user = { username: d.username || this._creds.username, main_url: d.main_url };
        sessionStorage.setItem(this.storageKey, b64(JSON.stringify(this._creds)));
        this.emitter.emit('login', this._user);
        return this._user;
      } catch (e) {
        this._creds = null;
        this._user = null;
        sessionStorage.removeItem(this.storageKey);
        throw e;
      }
    }

    /** Probeer auto-login met opgeslagen creds. */
    async tryAutoLogin() {
      const stored = sessionStorage.getItem(this.storageKey);
      if (!stored) return null;
      try {
        this._creds = JSON.parse(unb64(stored));
        const d = await this.client.request('/api/auth/login', { method: 'POST' });
        this._user = { username: d.username || this._creds.username, main_url: d.main_url };
        this.emitter.emit('login', this._user);
        return this._user;
      } catch {
        this._creds = null;
        this._user = null;
        sessionStorage.removeItem(this.storageKey);
        return null;
      }
    }

    logout() {
      this._creds = null;
      this._user = null;
      sessionStorage.removeItem(this.storageKey);
      this.emitter.emit('logout');
    }
  }

  // ==========================================================================
  // GRADES MODULE
  // ==========================================================================
  class GradesModule {
    constructor(client, emitter) {
      this.client = client;
      this.emitter = emitter;
      this._cache = null;
    }

    /**
     * Haal cijfers op.
     * @param {boolean} detail - true = met commentaar + tendensen
     * @returns {Promise<{courses, total_evaluations, total_courses}>}
     */
    async load(detail = false) {
      const d = await this.client.request(
        `/api/grades?detail=${detail ? '1' : '0'}`
      );
      this._cache = d;
      this.emitter.emit('grades:loaded', d);
      return d;
    }

    get cache() { return this._cache; }
  }

  // ==========================================================================
  // MESSAGES MODULE
  // ==========================================================================
  class MessagesModule {
    constructor(client, emitter) {
      this.client = client;
      this.emitter = emitter;
      this._currentBox = 'inbox';
      this._list = [];
      this._currentMessage = null;
      this._composeState = this._newComposeState();
      this._searchTimers = {};
    }

    get currentBox() { return this._currentBox; }
    get list() { return this._list; }
    get currentMessage() { return this._currentMessage; }
    get composeState() { return this._composeState; }

    // ----- LIST -----

    async loadList(box = 'inbox') {
      this._currentBox = box;
      this.emitter.emit('messages:loading', { box });
      try {
        const d = await this.client.request(
          `/api/messages?box=${encodeURIComponent(box)}`
        );
        this._list = d.messages || [];
        this.emitter.emit('messages:loaded', { box, messages: this._list });
        return this._list;
      } catch (e) {
        this.emitter.emit('messages:error', { box, error: e });
        throw e;
      }
    }

    // ----- READ -----

    async openMessage(id, box) {
      const b = box || this._currentBox;
      this.emitter.emit('messages:opening', { id, box: b });
      try {
        const m = await this.client.request(
          `/api/messages/${id}?box=${encodeURIComponent(b)}`
        );
        if (m.error) throw new Error(m.error);
        this._currentMessage = m;
        this.emitter.emit('messages:opened', { id, box: b, message: m });

        // Markeer als gelezen (fire-and-forget)
        if (b !== 'draft') {
          this._markRead(id, b).catch(() => {});
        }
        return m;
      } catch (e) {
        this.emitter.emit('messages:error', { id, box: b, error: e });
        throw e;
      }
    }

    async _markRead(id, box) {
      try {
        const d = await this.client.request(
          `/api/messages/${id}/read?box=${encodeURIComponent(box)}`,
          { method: 'POST' }
        );
        if (d.ok) {
          // Update lokale state
          const m = this._list.find(x => x.id === id);
          if (m) m.unread = false;
          this.emitter.emit('messages:read', { id, box });
        }
        return d;
      } catch { return { ok: false }; }
    }

    // ----- ACTIONS -----

    async action(id, action) {
      const d = await this.client.request(
        `/api/messages/${id}/action`,
        { method: 'POST', body: JSON.stringify({ action }) }
      );
      this.emitter.emit('messages:action', { id, action, result: d });
      if (action === 'trash' || action === 'archive') {
        this._list = this._list.filter(x => x.id !== id);
        if (this._currentMessage && this._currentMessage.id === id) {
          this._currentMessage = null;
        }
      }
      return d;
    }

    async markAllRead(box = 'inbox') {
      const d = await this.client.request(
        `/api/messages/mark-all-read?box=${encodeURIComponent(box)}`,
        { method: 'POST' }
      );
      this._list.forEach(m => m.unread = false);
      this.emitter.emit('messages:all-read', { box, marked: d.marked });
      return d;
    }

    // ----- ATTACHMENTS -----

    async downloadAttachment(msgId, fileId) {
      const blob = await this.client.download(
        `/api/messages/${msgId}/attachment/${fileId}`
      );
      this.emitter.emit('messages:attachment-downloaded', { msgId, fileId, blob });
      return blob;
    }

    // ----- SEARCH USERS -----

    async searchUsers(q, type = 'all') {
      const d = await this.client.request(
        `/api/messages/search-users?q=${encodeURIComponent(q)}&type=${type}`
      );
      return d.users || [];
    }

    /** Debounced search wrapper */
    debouncedSearch(role, q, cb, delay = 250) {
      clearTimeout(this._searchTimers[role]);
      this._searchTimers[role] = setTimeout(async () => {
        try {
          const users = await this.searchUsers(q);
          cb(null, users);
        } catch (e) {
          cb(e, null);
        }
      }, delay);
    }

    // ----- COMPOSE -----

    _newComposeState() {
      return {
        to: [], cc: [], bcc: [],
        attachments: [],
        draftId: null,
        subject: '',
        bodyHtml: '',
        sendDate: '',
      };
    }

    startCompose() {
      this._composeState = this._newComposeState();
      this.emitter.emit('compose:started', this._composeState);
    }

    async editDraft(draftId) {
      const d = await this.client.request(`/api/messages/draft/${draftId}`);
      if (d.error) throw new Error(d.error);
      this._composeState = {
        to: (d.receivers?.to || []).map(this._normalizeUser),
        cc: (d.receivers?.cc || []).map(this._normalizeUser),
        bcc: (d.receivers?.bcc || []).map(this._normalizeUser),
        attachments: [],
        draftId: draftId,
        subject: d.subject || '',
        bodyHtml: d.body || '',
        sendDate: '',
      };
      this.emitter.emit('compose:draft-loaded', this._composeState);
      return this._composeState;
    }

    _normalizeUser(u) {
      return {
        user_id: u.user_id,
        name: u.name,
        display_name: u.display_name || u.name,
        is_co_account: u.is_co_account,
        ss_id: u.ss_id,
        type_label: u.type_label || '',
      };
    }

    addRecipient(role, user) {
      const st = this._composeState;
      if (!st[role]) st[role] = [];
      if (st[role].some(x => x.user_id === user.user_id)) return false;
      st[role].push(this._normalizeUser(user));
      this.emitter.emit('compose:changed', st);
      return true;
    }

    removeRecipient(role, index) {
      const st = this._composeState;
      if (st[role]) st[role].splice(index, 1);
      this.emitter.emit('compose:changed', st);
    }

    setSubject(s) {
      this._composeState.subject = s;
      this.emitter.emit('compose:changed', this._composeState);
    }

    setBodyHtml(html) {
      this._composeState.bodyHtml = html;
      this.emitter.emit('compose:changed', this._composeState);
    }

    setSendDate(s) {
      this._composeState.sendDate = s;
      this.emitter.emit('compose:changed', this._composeState);
    }

    async uploadAttachment(file) {
      const fd = new FormData();
      fd.append('file', file);
      const data = await this.client.upload('/api/upload-smartschool', fd);
      if (!data.url) throw new Error('geen URL');
      this._composeState.attachments.push(data);
      this.emitter.emit('compose:changed', this._composeState);
      return data;
    }

    removeAttachment(index) {
      this._composeState.attachments.splice(index, 1);
      this.emitter.emit('compose:changed', this._composeState);
    }

    async send() {
      const st = this._composeState;
      if (!st.subject.trim()) throw new Error('Onderwerp verplicht');
      if (!st.to.length) throw new Error('Minimaal 1 ontvanger');

      const payload = {
        subject: st.subject,
        message_html: st.bodyHtml,
        message: stripHtml(st.bodyHtml),
        to: st.to, cc: st.cc, bcc: st.bcc,
        attachments: st.attachments,
        send_date: st.sendDate || undefined,
      };
      if (st.draftId) payload.draft_id = st.draftId;

      const r = await this.client.request('/api/messages/send', {
        method: 'POST', body: JSON.stringify(payload),
      });
      this.emitter.emit('compose:sent', r);
      return r;
    }

    cancelCompose() {
      this._composeState = this._newComposeState();
      this.emitter.emit('compose:cancelled');
    }
  }

  // ==========================================================================
  // PLANNER MODULE
  // ==========================================================================
  class PlannerModule {
    constructor(client, emitter) {
      this.client = client;
      this.emitter = emitter;
      this._offset = 0;
      this._weekData = null;
      this._todos = [];
      this._todoScope = 'open';
      this._myClass = null;
      this._myClassExam = false;
      this._myClassScore = 0;
    }

    get offset() { return this._offset; }
    get weekData() { return this._weekData; }
    get todos() { return this._todos; }
    get todoScope() { return this._todoScope; }
    get myClass() { return this._myClass; }
    get isExamWeek() { return this._myClassExam; }

    // ----- WEEK -----

    async loadWeek(offset = 0) {
      this._offset = offset;
      this.emitter.emit('planner:week-loading', { offset });
      try {
        const d = await this.client.request(
          `/api/planner/week?offset=${offset}`
        );
        this._weekData = d;
        this.emitter.emit('planner:week-loaded', { offset, data: d });
        return d;
      } catch (e) {
        this.emitter.emit('planner:error', { offset, error: e });
        throw e;
      }
    }

    shiftWeek(delta) {
      this._offset += delta;
      return this.loadWeek(this._offset);
    }

    goToToday() {
      return this.loadWeek(0);
    }

    /** Klas info ophalen (gecached op backend) */
    async loadMyClass() {
      try {
        const d = await this.client.request('/api/planner/my-class');
        this._myClass = d.class || null;
        this._myClassExam = !!d.exam_week;
        this._myClassScore = d.score || 0;
        this.emitter.emit('planner:my-class', d);
        return d;
      } catch (e) {
        this._myClass = null;
        this._myClassExam = false;
        this.emitter.emit('planner:my-class-error', e);
        throw e;
      }
    }

    // ----- TODOS -----

    async loadTodos(scope = 'open') {
      this._todoScope = scope;
      this.emitter.emit('planner:todos-loading', { scope });
      try {
        const d = await this.client.request(
          `/api/planner/todos?scope=${scope}&limit=100`
        );
        this._todos = d.items || [];
        this.emitter.emit('planner:todos-loaded', {
          scope,
          items: this._todos,
          meta: d.meta || {},
        });
        return d;
      } catch (e) {
        this.emitter.emit('planner:todos-error', { scope, error: e });
        throw e;
      }
    }

    setTodoScope(scope) {
      return this.loadTodos(scope);
    }

    // ----- TODO ACTIONS -----

    /** Optimistische toggle: past state aan, dan API. */
    /* ============================================================
 * FIX voor toggleTodo bug in ss1.js
 * De library keert `done` om: done=true → unresolve (fout)
 * Deze versie doet het correct: done=true → resolve
 * ============================================================ */
ss.planner.toggleTodo = async function(id, type, done) {
  const todo = this._todos.find(t => t.i === id);
  const prevSt = todo ? todo.st : "";

  // Optimistic update — JUIST: done=true → "resolved", done=false → ""
  if (todo) todo.st = done ? "resolved" : "";
  this.emitter.emit("planner:todos-changed", this._todos);

  // JUISTE actie: done=true → resolve, done=false → unresolve
  const action = done ? "resolve" : "unresolve";
  const platform = this._platformId();

  if (!platform) {
    if (todo) todo.st = prevSt;
    this.emitter.emit("planner:todos-changed", this._todos);
    throw new Error("Platform ID niet gevonden");
  }

  try {
    await this.client.request(
      `/api/planner/${platform}/${id}/${action}?type=${type}`,
      { method: "POST" }
    );
    this.emitter.emit("planner:todo-toggled", { id, type, action });
    return true;
  } catch (err) {
    // Rollback bij fout
    if (todo) todo.st = prevSt;
    this.emitter.emit("planner:todos-changed", this._todos);
    throw err;
  }
};

    async deleteTodo(id, type) {
      const platform = this._platformId();
      if (!platform) throw new Error('Platform ID niet gevonden');
      await this.client.request(
        `/api/planner/${platform}/${id}/trash?type=${type}`,
        { method: 'POST' }
      );
      this._todos = this._todos.filter(x => x.i !== id);
      this.emitter.emit('planner:todos-changed', this._todos);
      this.emitter.emit('planner:todo-deleted', { id, type });
    }

    async createTodo({ name, description, date_from, date_to, color, whole_day }) {
      const d = await this.client.request('/api/planner/todo', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description || '',
          date_from: date_from || undefined,
          date_to: date_to || undefined,
          color: color || 'blue-200',
          icon: 'icon_fill_flag',
          whole_day: whole_day !== undefined ? whole_day : true,
        }),
      });
      this.emitter.emit('planner:todo-created', d);
      return d;
    }

    // ----- ITEM ACTIONS (planner taken via modal) -----

    async itemAction(id, action, type) {
      const platform = this._platformId();
      if (!platform) throw new Error('Platform ID niet gevonden');
      const d = await this.client.request(
        `/api/planner/${platform}/${id}/${action}?type=${type}`,
        { method: 'POST' }
      );
      this.emitter.emit('planner:item-action', { id, action, type, result: d });
      return d;
    }

    // ----- HELPERS -----

    _platformId() {
      const uid = this._weekData?.meta?.user_id || '';
      return uid.split('_')[0] || null;
    }

    /** Groepeer items per dag+uur voor rendering */
    groupBySlot() {
      const data = this._weekData;
      if (!data) return { perSlot: {}, perWholeday: {} };

      const hours = data.hours || [];
      const items = data.items || [];
      const perSlot = {};
      const perWholeday = {};

      const now = new Date();
      const monday = this._mondayOf(this._offset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);

      for (const it of items) {
        if (!it.df) continue;
        const dt = new Date(it.df);
        const dk = this._dateKey(dt);
        const d0 = new Date(dk + 'T00:00:00');
        if (d0 < monday || d0 > sunday) continue;

        if (it.wd === 1) {
          (perWholeday[dk] = perWholeday[dk] || []).push(it);
          continue;
        }

        const hh = dt.getHours();
        const mm = dt.getMinutes();
        const timeStr = String(hh).padStart(2, '0') + ':' +
                        String(mm).padStart(2, '0');
        let match = hours.find(h => (h.s || h.start) === timeStr);
        if (!match) {
          let best = 9999;
          for (const h of hours) {
            const hs = (h.s || h.start).split(':');
            const delta = Math.abs(
              parseInt(hs[0]) * 60 + parseInt(hs[1]) - (hh * 60 + mm)
            );
            if (delta < best) { best = delta; match = h; }
          }
        }
        if (!match) continue;
        const hid = match.id || match.hour_id;
        const key = dk + '|' + hid;
        (perSlot[key] = perSlot[key] || []).push(it);
      }

      return { perSlot, perWholeday };
    }

    getWeekBounds() {
      const monday = this._mondayOf(this._offset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);
      return { monday, sunday };
    }

    _mondayOf(offset = 0) {
      const now = new Date();
      const day = now.getDay() || 7;
      const m = new Date(now);
      m.setDate(now.getDate() - (day - 1) + offset * 7);
      m.setHours(0, 0, 0, 0);
      return m;
    }

    _dateKey(d) {
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }
  }

  // ==========================================================================
  // PROFILE MODULE
  // ==========================================================================
  class ProfileModule {
    constructor(client, emitter) {
      this.client = client;
      this.emitter = emitter;
      this._fields = null;
    }

    get fields() { return this._fields; }

    async load() {
      const d = await this.client.request('/api/profile');
      this._fields = d.fields;
      this.emitter.emit('profile:loaded', d.fields);
      return d.fields;
    }

    async save(changes) {
      const d = await this.client.request('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ changes }),
      });
      this.emitter.emit('profile:saved', d);
      return d;
    }

    /** Bereken gewijzigde velden */
    diff(currentValues) {
      const changes = {};
      if (!this._fields) return changes;
      for (const k of Object.keys(currentValues)) {
        const orig = this._fields[k]?.value;
        if (orig !== currentValues[k]) changes[k] = currentValues[k];
      }
      return changes;
    }
  }

  // ==========================================================================
  // UPLOAD MODULE (voor compose)
  // ==========================================================================
  class UploadModule {
    constructor(client) {
      this.client = client;
    }

    async uploadFile(file) {
      const fd = new FormData();
      fd.append('file', file);
      return this.client.upload('/api/upload-smartschool', fd);
    }
  }

  // ==========================================================================
  // UTILS
  // ==========================================================================
  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  // ==========================================================================
  // MAIN CLIENT
  // ==========================================================================
  class SmartschoolClient extends Emitter {
    constructor(opts = {}) {
      super();
      this.apiURL = opts.apiURL || DEFAULT_API;
      this.storageKey = opts.storageKey || STORAGE_KEY;

      // Creds provider voor HTTP client
      this._credsGetter = () => this.auth.creds;

      this._http = new HttpClient(this.apiURL, this._credsGetter);

      // Modules
      this.auth = new AuthModule(this._http, this, this.storageKey);
      this.grades = new GradesModule(this._http, this);
      this.messages = new MessagesModule(this._http, this);
      this.planner = new PlannerModule(this._http, this);
      this.profile = new ProfileModule(this._http, this);
      this.uploads = new UploadModule(this._http);
    }

    /** Convenience: login wrapper */
    async login(creds) {
      return this.auth.login(creds);
    }

    async tryAutoLogin() {
      return this.auth.tryAutoLogin();
    }

    logout() {
      this.auth.logout();
    }

    /** Bulk: laad alles in voor de app */
    async bootstrap() {
      await Promise.allSettled([
        this.grades.load(false),
        this.planner.loadWeek(0),
        this.planner.loadMyClass(),
        this.planner.loadTodos('open'),
      ]);
    }
  }

  // ==========================================================================
  // EXPORTS
  // ==========================================================================
  global.Smartschool = SmartschoolClient;
  global.SmartschoolClient = SmartschoolClient;
  global.smartschoolUtils = { b64, unb64, stripHtml, parseJSON };

  // Auto-instance (optioneel)
  if (typeof global.ss === 'undefined') {
    global.ss = new SmartschoolClient();
  }

})(typeof window !== 'undefined' ? window : globalThis);
