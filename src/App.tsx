import { useEffect, useState } from 'react';
import { armAudio, sfx } from './app/audio';
import { SettingsDialog } from './app/components/SettingsDialog';
import { Home } from './app/pages/Home';
import { Lab } from './app/pages/Lab';
import { Play } from './app/pages/Play';
import { useRoute } from './app/router';
import { useSettings } from './app/settings';
import { setVoiceEnabled } from './engine/audio/speech';

export function App() {
  const route = useRoute();
  const [settings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(armAudio, []);
  useEffect(() => sfx.setEnabled(settings.sound), [settings.sound]);
  useEffect(() => setVoiceEnabled(settings.voice), [settings.voice]);

  const openSettings = (): void => setSettingsOpen(true);
  return (
    <>
      {route.page === 'home' && <Home onSettings={openSettings} />}
      {route.page === 'play' && <Play key={route.game} game={route.game} onSettings={openSettings} />}
      {route.page === 'lab' && <Lab />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
