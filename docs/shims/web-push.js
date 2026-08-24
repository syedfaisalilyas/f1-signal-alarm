// web-push, minus the sending. notify.js imports it for VAPID signing, which
// only a server can do — in the page, alerts land in the UI and Telegram is
// handled by the scheduled scanner instead.
export default {
  setVapidDetails() {},
  sendNotification() { return Promise.reject(new Error('web push needs a server')); },
  generateVAPIDKeys() { return { publicKey: '', privateKey: '' }; }
};
