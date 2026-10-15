const KNOWN_DOMAINS: string[] = [
  'https://mybuffstreams.plus',
  ...(process.env.BUFFSTREAMS_BASE_URL ? [process.env.BUFFSTREAMS_BASE_URL.replace(/\/+$/, '')] : []),
  'https://buffstreams.ir',
];

let cachedUrl: string = KNOWN_DOMAINS[0];
let lastProbeMs = 0;
const PROBE_TTL_MS = 2 * 60 * 1000;
let probing: Promise<void> | null = null;
let probeBackoff = 0;

async function probeDomain(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${url}/index7`, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);
    return res.ok || res.status === 403 || res.status === 429;
  } catch {
    return false;
  }
}

async function probeAll(): Promise<string> {
  for (const domain of KNOWN_DOMAINS) {
    if (await probeDomain(domain)) {
      return domain;
    }
  }
  return KNOWN_DOMAINS[0];
}

function startProbe(): void {
  if (probing) return;
  if (Date.now() - lastProbeMs < PROBE_TTL_MS) return;
  probing = probeAll()
    .then((url) => {
      cachedUrl = url;
      lastProbeMs = Date.now();
      probeBackoff = 0;
      probing = null;
    })
    .catch(() => {
      probeBackoff = Math.min(probeBackoff + 1, 4);
      probing = null;
    });
}

startProbe();

export const BaseUrlResolver = {
  getBaseUrl(): string {
    return cachedUrl || KNOWN_DOMAINS[0];
  },

  async forceProbe(): Promise<string> {
    const url = await probeAll();
    cachedUrl = url;
    lastProbeMs = Date.now();
    probeBackoff = 0;
    probing = null;
    return url;
  },

  getProbeBackoff(): number {
    return probeBackoff;
  },
};
