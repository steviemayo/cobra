import type { Provider } from './types';
import { logitech } from './logitech';
import { reflect } from './reflect';
import { teams } from './teams';
import { zoom } from './zoom';

// Every integration type Kestrel can talk to. A provider is added here once it has a module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: Provider<any>[] = [zoom, reflect, logitech, teams];

export const listProviders = () => providers;
export const getProvider = (id: string) => providers.find((p) => p.id === id);
