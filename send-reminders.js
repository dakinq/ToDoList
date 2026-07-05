const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const messaging = admin.messaging();

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function deleteOldCompleted() {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
  const snapshot = await db.collection('todos')
    .where('done', '==', true)
    .where('completedAt', '<', cutoff)
    .get();

  let count = 0;
  const batch = db.batch();
  snapshot.forEach(doc => { batch.delete(doc.ref); count++; });
  if (count > 0) {
    await batch.commit();
    console.log(`${count} erledigte To-do(s) nach 24h gelöscht.`);
  } else {
    console.log('Keine alten erledigten To-dos zum Löschen.');
  }
}

async function sendReminders() {
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

  const tokensSnapshot = await db.collection('tokens').get();
  const tokens = [];
  tokensSnapshot.forEach(doc => tokens.push(doc.data().token));

  if (tokens.length === 0) { console.log('Keine Push-Tokens gefunden.'); return; }

  for (const todo of dueTodos) {
    const title = todo.dueDate < today ? '⚠️ Überfällig' : '📅 Heute fällig';
    const body = todo.text + (todo.assignee ? ' · ' + todo.assignee : '') + (todo.priority ? ' · Prio ' + todo.priority : '');

    try {
      const response = await messaging.sendEachForMulticast({ tokens, notification: { title, body } });
      console.log(`Erinnerung "${todo.text}": ${response.successCount} ok, ${response.failureCount} fehlgeschlagen`);

      response.responses.forEach((res, idx) => {
        if (!res.success && res.error && res.error.code === 'messaging/registration-token-not-registered') {
          db.collection('tokens').doc(tokens[idx]).delete().catch(() => {});
        }
      });

      await db.collection('todos').doc(todo.id).update({ notified: true });
    } catch (e) {
      console.error(`Fehler bei "${todo.text}":`, e.message);
    }
  }
}

async function main() {
  await deleteOldCompleted();
  await sendReminders();
}

main().catch(err => { console.error(err); process.exit(1); });
