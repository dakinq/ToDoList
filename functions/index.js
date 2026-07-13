const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});

const db = admin.firestore();

// Hilfsfunktion: Push an alle gespeicherten Tokens senden
async function sendPushToAll(title, body) {
  const tokensSnap = await db.collection("tokens").get();
  if (tokensSnap.empty) {
    console.log("Keine Tokens gefunden.");
    return;
  }

  const tokens = tokensSnap.docs.map((d) => d.data().token).filter(Boolean);
  console.log(`Sende Push an ${tokens.length} Gerät(e): ${title}`);

  const promises = tokens.map((token) =>
    admin.messaging().send({
      token,
      notification: { title, body },
      webpush: {
        notification: {
          title,
          body,
          icon: "https://dakinq.github.io/ToDoList/icon-192.png",
        },
      },
    }).catch((err) => {
      console.error(`Fehler bei Token ${token.substring(0, 20)}:`, err.message);
      // Ungültigen Token automatisch löschen
      if (
        err.code === "messaging/invalid-registration-token" ||
        err.code === "messaging/registration-token-not-registered"
      ) {
        return db.collection("tokens").doc(token).delete();
      }
    })
  );

  await Promise.all(promises);
}

// Trigger: Todo erstellt oder geändert
exports.onTodoWrite = functions.firestore
  .document("todos/{todoId}")
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;

    // Todo gelöscht → nichts tun
    if (!after) return null;

    // Neues Todo erstellt
    if (!before && after.notifiedCreation === false) {
      const author = after.authorEmail
        ? after.authorEmail.split("@")[0]
        : "Jemand";
      const category = after.category ? ` [${after.category}]` : "";
      await sendPushToAll("Neuer Eintrag", `${author}: ${after.text}${category}`);
      await change.after.ref.update({ notifiedCreation: true });
      return null;
    }

    // Todo erledigt
    if (
      after.done === true &&
      after.notifiedCompletion === false &&
      before &&
      before.done === false
    ) {
      const who = after.completedByEmail
        ? after.completedByEmail.split("@")[0]
        : "Jemand";
      await sendPushToAll("Erledigt ✓", `${who} hat „${after.text}" abgehakt`);
      await change.after.ref.update({ notifiedCompletion: true });
      return null;
    }

    return null;
  });
