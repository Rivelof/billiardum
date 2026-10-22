import { api } from './api.js';
import { base64UrlToBytes } from './platform.js';

/**
 * Подписка на Web Push: разрешение браузера, сервис-воркер, ключ VAPID, подписка на сервере (§14).
 * @returns {Promise<'done' | 'denied'>} denied — гость не разрешил уведомления
 */
export async function subscribePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const key = import.meta.env?.VITE_VAPID_PUBLIC_KEY || (await api.pushKey())?.public_key;
  if (!key) throw new Error('no vapid key');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) }));
  await api.pushSubscribe(sub.toJSON());
  return 'done';
}
