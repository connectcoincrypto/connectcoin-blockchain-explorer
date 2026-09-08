// Runs before the app and its styles so a saved dark preference never flashes a light page.
// Kept external to preserve the production Content Security Policy (no inline script permission).
(() => {
  const storageKey = 'connectcoin-explorer-theme';
  const normalize = (value) => (value === 'light' || value === 'dark' ? value : 'system');
  const readPreference = () => {
    try {
      return normalize(window.localStorage.getItem(storageKey));
    } catch {
      return 'system';
    }
  };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set();
  let preference = readPreference();
  const apply = () => {
    const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  };
  const notify = () => {
    apply();
    for (const listener of listeners) listener();
  };
  window.connectcoinTheme = {
    getPreference: () => preference,
    setPreference: (value) => {
      preference = normalize(value);
      try {
        window.localStorage.setItem(storageKey, preference);
      } catch {
        // Private browsing or disabled storage must not prevent changing this page's theme.
      }
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  media.addEventListener('change', () => {
    if (preference === 'system') apply();
  });
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) {
      preference = readPreference();
      notify();
    }
  });
  apply();
})();
