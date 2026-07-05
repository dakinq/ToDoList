importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDfTQHSnhdX5-Z-3MCeDPpDeKXcuEbV1zE",
  authDomain: "todoliste-badfd.firebaseapp.com",
  projectId: "todoliste-badfd",
  storageBucket: "todoliste-badfd.firebasestorage.app",
  messagingSenderId: "764723309146",
  appId: "1:764723309146:web:75a7f9c88264a967c30663"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Erinnerung';
  const options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png'
  };
  self.registration.showNotification(title, options);
});
