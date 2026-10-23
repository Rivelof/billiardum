// Изнутри сети Docker (любой контейнер default) прямо на server:3000: X-Forwarded-For принимается.
const codes = {};
for (let i = 0; i < 130; i += 1) {
  const r = await fetch('http://server:3000/api/public/cities', { headers: { 'x-forwarded-for': '10.231.47.2' } });
  await r.arrayBuffer();
  codes[r.status] = (codes[r.status] ?? 0) + 1;
}
const codes2 = {};
for (let i = 0; i < 130; i += 1) {
  const r = await fetch('http://server:3000/api/public/cities');
  await r.arrayBuffer();
  codes2[r.status] = (codes2[r.status] ?? 0) + 1;
}
console.log(JSON.stringify({ spoofed_site_ip: codes, own_ip: codes2 }));
