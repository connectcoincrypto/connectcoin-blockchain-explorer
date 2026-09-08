import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

type ThemePreference = 'system' | 'light' | 'dark';
declare global {
  interface Window {
    connectcoinTheme: {
      getPreference(): ThemePreference;
      setPreference(value: ThemePreference): void;
      subscribe(listener: () => void): () => void;
    };
  }
}

export function ThemePicker() {
  const controller = window.connectcoinTheme;
  const preference = useSyncExternalStore(controller.subscribe, controller.getPreference, () => 'system');
  const Icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  return (
    <label className="theme-picker">
      <Icon size={16} aria-hidden="true" />
      <select
        aria-label="Color theme"
        title="Color theme"
        value={preference}
        onChange={(event) => controller.setPreference(event.target.value as ThemePreference)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
