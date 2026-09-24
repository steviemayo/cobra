import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@kestrel/panel-ui/panel.css';
import { PanelSession, WsPanelClient } from '@kestrel/panel-ui';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// The gateway serves this at /room/<id>. In development, ?room=<id> works too.
const roomId =
  UUID.exec(location.pathname)?.[0] ?? new URLSearchParams(location.search).get('room') ?? '';

const root = createRoot(document.getElementById('root')!);

if (!UUID.test(roomId)) {
  root.render(
    <p style={{ color: '#9aa8b3', font: '20px system-ui', padding: 40 }}>
      Open this panel from its room address, for example /room/&lt;room id&gt;.
    </p>,
  );
} else {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const client = new WsPanelClient(`${scheme}://${location.host}/ws/${roomId}`);
  root.render(
    <StrictMode>
      <PanelSession client={client} />
    </StrictMode>,
  );
}
