import { hostname as machineName } from 'node:os';
import { isIP } from 'node:net';
// A web page can reach a gateway on the customer's network from a browser that is on it: with DNS
// rebinding it can make the browser treat the gateway as the page's own site. The Host header must
// be a name the gateway is meant to be reached by.

/** The host part of a Host header, lower case, without the port or IPv6 brackets. */
export function hostOnly(header: string | undefined): string | null {
  if (!header) return null;
  const h = header.trim().toLowerCase();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(h) ?? /^([^:]+)(?::\d+)?$/.exec(h);
  return m ? m[1]! : null;
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.internal', '.localdomain', '.home.arpa'];

/**
 * Whether a request's Host header names this gateway the way a person on its network would:
 * an IP address, localhost, the machine's own name, a bare name (`av-gateway`), a local suffix
 * (`.local`, `.lan`), or one the operator listed in KESTREL_ALLOWED_HOSTS (`*` allows any, and
 * `*.example.com` allows a domain). A public-looking name that is none of these is refused, which
 * is what a rebinding page has to use.
 */
export function makeHostCheck(
  extra: readonly string[] = [],
  machine: string = machineName(),
): (hostHeader: string | undefined) => boolean {
  const own = machine.toLowerCase();
  const short = own.split('.')[0]!;
  const listed = extra.map((h) => h.trim().toLowerCase()).filter(Boolean);
  return (header) => {
    const host = hostOnly(header);
    if (!host) return false;
    if (isIP(host)) return true;
    const name = host.replace(/\.$/, '');
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    if (name === own || name === short || name === `${short}.local`) return true;
    if (!name.includes('.')) return true;
    if (LOCAL_SUFFIXES.some((s) => name.endsWith(s))) return true;
    return listed.some((p) => p === '*' || p === name || (p.startsWith('*.') && name.endsWith(p.slice(1))));
  };
}
