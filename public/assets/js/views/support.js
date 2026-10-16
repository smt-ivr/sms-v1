// צ'אט תמיכה עם מנהל המערכת
import { api, route, state, $, esc, icon, toast, modal, on, formValues, emptyState, listTime, dayLabel, hhmm, linkify, go } from '../core.js';

export function chatHtml(messages, mineRole) {
  let last = '';
  return messages.map((m) => {
    const d = dayLabel(m.created_at);
    const sep = d !== last ? `<div class="day-sep">${esc(d)}</div>` : '';
    last = d;
    const mine = m.sender_role === mineRole;
    return `${sep}<div class="bubble ${mine ? 'mine' : 'admin'}">${!mine ? `<div class="by">${esc(m.sender_role === 'admin' ? (m.sender_name || 'מנהל המערכת') : (m.sender_name || 'משתמש'))}</div>` : ''}${linkify(m.body)}<div class="foot">${hhmm(m.created_at)}</div></div>`;
  }).join('');
}

function newThread() {
  modal({
    title: 'פנייה חדשה',
    body: `<div class="field"><label>נושא</label><input name="subject" maxlength="100" placeholder="במשפט אחד, במה צריך עזרה?"></div>
           <div class="field"><label>פירוט</label><textarea name="body" rows="5"></textarea></div>`,
    actions: [{ label: 'ביטול' }, { label: 'שליחה', kind: 'primary', onClick: async (m) => { const r = await api('/api/support/threads', { method: 'POST', body: formValues(m.body) }); toast('הפנייה נשלחה'); go(`#/support/${r.id}`); } }],
  });
}

export function register() {
  const handler = async (view, params) => {
    const active = params.id ? Number(params.id) : null;
    view.innerHTML = `
      <div class="support ${active ? 'show-thread' : ''}" id="sup">
        <section class="conv-col"><div class="conv-tools"><b style="flex:1;align-self:center">הפניות שלי</b><button class="btn btn-primary btn-sm" id="new">${icon('add')} פנייה</button></div><div class="conv-list" id="list"></div></section>
        <section class="thread-col" id="thread"></section>
      </div>`;
    $('#new', view).addEventListener('click', newThread);
    const list = $('#list', view);
    const thread = $('#thread', view);
    let timer = null;

    async function drawList() {
      const threads = await api('/api/support/threads');
      list.innerHTML = threads.length ? threads.map((t) => `
        <a class="conv ${t.user_unread ? 'unread' : ''} ${t.id === active ? 'active' : ''}" href="#/support/${t.id}" style="text-decoration:none;color:inherit">
          <span class="avatar">${icon(t.status === 'closed' ? 'task_alt' : 'support_agent')}</span>
          <span class="who">${esc(t.subject)}</span><span class="when">${listTime(t.updated_at)}</span>
          <span class="snip">${esc(t.last_body || '')}</span><span class="meta">${t.user_unread ? `<span class="unread-n">${t.user_unread}</span>` : ''}</span>
        </a>`).join('') : emptyState({ ic: 'support_agent', title: 'אין פניות', text: 'שאלה, תקלה או בקשה לשדרוג — כתוב למנהל המערכת.' });
    }

    async function drawThread(silent) {
      if (!active) { thread.innerHTML = `<div class="thread-empty"><div>${icon('support_agent', 'big')}<h3>תמיכה</h3><p class="muted">בחר פנייה או פתח פנייה חדשה.</p></div></div>`; return; }
      try {
        const { thread: t, messages } = await api(`/api/support/threads/${active}`);
        const draft = $('#msg', thread) ? $('#msg', thread).value : '';
        thread.innerHTML = `
          <div class="thread-head"><a class="icon-btn show-sm" href="#/support">${icon('arrow_forward')}</a>
            <div class="who"><b>${esc(t.subject)}</b><small>${t.status === 'closed' ? 'הפנייה סגורה — אפשר לכתוב כדי לפתוח אותה מחדש' : 'פתוחה'}</small></div></div>
          <div class="thread-body" id="tb">${chatHtml(messages, 'user')}</div>
          <div class="composer"><div class="composer-row"><textarea id="msg" rows="1" placeholder="כתיבת הודעה…"></textarea><button class="send" id="send" aria-label="שליחה">${icon('send')}</button></div></div>`;
        $('#msg', thread).value = draft;
        const tb = $('#tb', thread); tb.scrollTop = tb.scrollHeight;
        if (!silent) $('#msg', thread).focus();
        if (state.me.unread.support) drawList();
      } catch (e) { thread.innerHTML = `<div class="thread-empty"><p>${esc(e.message)}</p></div>`; }
    }

    async function send() {
      const msg = $('#msg', thread);
      const text = msg.value.trim();
      if (!text) return;
      const btn = $('#send', thread); btn.disabled = true;
      try { await api(`/api/support/threads/${active}/messages`, { method: 'POST', body: { body: text } }); msg.value = ''; await drawThread(); drawList(); } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
    }
    on(thread, 'click', '#send', send);
    on(thread, 'keydown', '#msg', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    await Promise.all([drawList(), drawThread()]);
    timer = setInterval(() => { if (!document.hidden && active) drawThread(true); }, 20_000);
    return () => clearInterval(timer);
  };
  route('/support', handler, { title: 'תמיכה', nav: 'support' });
  route('/support/:id', handler, { title: 'תמיכה', nav: 'support' });
}
