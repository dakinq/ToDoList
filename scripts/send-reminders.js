const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const messaging = admin.messaging();

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

// Hinweis: Das automatische Löschen wurde entfernt.
// Erledigte/gelöschte To-dos werden jetzt ausschließlich manuell
// über die Einstellungen in der App aufgeräumt.

async function getTokensExcept(excludeEmail) {
  const snapshot = await db.collection('tokens').get();
  const tokens = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!excludeEmail || data.email !== excludeEmail) tokens.push(data.token);
  });
  return tokens;
}

async function sendToTokens(tokens, title, body) {
  if (tokens.length === 0) return { successCount: 0, failureCount: 0 };
  const response = await messaging.sendEachForMulticast({ tokens, notification: { title, body } });
  response.responses.forEach((res, idx) => {
    if (!res.success && res.error && res.error.code === 'messaging/registration-token-not-registered') {
      db.collection('tokens').doc(tokens[idx]).delete().catch(() => {});
    }
  });
  return response;
}

// ---- 1. Erinnerungen für fällige To-dos ----
async function sendDueReminders() {
  const today = todayDateString();
  const snapshot = await db.collection('todos')
    .where('done', '==', false)
    .where('notified', '==', false)
    .get();

  const dueTodos = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.dueDate && data.dueDate <= today) dueTodos.push({ id: doc.id, ...data });
  });

  if (dueTodos.length === 0) { console.log('Keine fälligen To-dos.'); return; }

  for (const todo of dueTodos) {
    const title = todo.dueDate < today ? '⚠️ Überfällig' : '📅 Heute fällig';
    const body = todo.text + (todo.assignee ? ' · ' + todo.assignee : '') + (todo.priority ? ' · Prio ' + todo.priority : '');
    const tokens = await getTokensExcept(null); // Fälligkeits-Erinnerung geht an alle
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Fälligkeits-Erinnerung "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
      await db.collection('todos').doc(todo.id).update({ notified: true });
    } catch (e) {
      console.error(`Fehler bei "${todo.text}":`, e.message);
    }
  }
}

// ---- 2. Benachrichtigung bei neuen Einträgen (an den jeweils ANDEREN Partner) ----
async function sendCreationNotifications() {
  const snapshot = await db.collection('todos')
    .where('notifiedCreation', '==', false)
    .get();

  if (snapshot.empty) { console.log('Keine neuen Einträge zu melden.'); return; }

  for (const doc of snapshot.docs) {
    const todo = doc.data();
    const tokens = await getTokensExcept(todo.authorEmail || null);
    const title = '📝 Neuer Eintrag';
    const body = todo.text + (todo.assignee ? ' · für ' + todo.assignee : '');
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Neuer Eintrag "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) {
      console.error(`Fehler bei Neu-Benachrichtigung "${todo.text}":`, e.message);
    }
    await doc.ref.update({ notifiedCreation: true });
  }
}

// ---- 3. Benachrichtigung bei erledigten Einträgen (an den jeweils ANDEREN Partner) ----
async function sendCompletionNotifications() {
  const snapshot = await db.collection('todos')
    .where('notifiedCompletion', '==', false)
    .get();

  if (snapshot.empty) { console.log('Keine neu erledigten Einträge zu melden.'); return; }

  for (const doc of snapshot.docs) {
    const todo = doc.data();
    if (!todo.done) { await doc.ref.update({ notifiedCompletion: true }); continue; }
    const tokens = await getTokensExcept(todo.completedByEmail || null);
    const title = '✅ Erledigt';
    const body = todo.text;
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Erledigt "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) {
      console.error(`Fehler bei Erledigt-Benachrichtigung "${todo.text}":`, e.message);
    }
    await doc.ref.update({ notifiedCompletion: true });
  }
}

async function main() {
  await sendDueReminders();
  await sendCreationNotifications();
  await sendCompletionNotifications();
}

main().catch(err => { console.error(err); process.exit(1); });
