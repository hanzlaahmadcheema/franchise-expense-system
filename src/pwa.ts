import { registerSW } from "virtual:pwa-register";

let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;

updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new Event("pwa-update-available"));
  },
  onOfflineReady() {
    window.dispatchEvent(new Event("pwa-offline-ready"));
  }
});

export async function applyPwaUpdate() {
  await updateServiceWorker?.(true);
}
