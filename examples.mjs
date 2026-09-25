// Regenerates the before/after images on the landing page with the real library.
//   npm run build && node docs/examples.mjs
// Photos are fetched once from Wikimedia Commons into docs/.photos/ (gitignored).
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { embed, extract, publicKeyOf, signingKeyFromSeed } from "../dist/src/index.js";
import { corpus } from "../dist/bench/corpus.js";

const SIZE = 1280; // signed-profile minimum
const OUT = new URL("./examples/", import.meta.url);
const masterKey = "landing-page-demo";
const signingKey = signingKeyFromSeed(new Uint8Array(32).fill(7)); // demo key, deliberately public
const verifyKeys = [publicKeyOf(signingKey)];
const payload = "rcpt-00000000042";

const C = "https://commons.wikimedia.org/wiki/File:";
const U = "https://upload.wikimedia.org/wikipedia/commons/";
const PHOTOS = [
  { name: "iceberg", credit: "Jeremy Harbeck, public domain", page: C + "Iceberg_in_North_Star_Bay,_Greenland.jpg",
    src: U + "e/e6/Iceberg_in_North_Star_Bay%2C_Greenland.jpg" },
  { name: "pond", credit: "George Chernilevsky, public domain", page: C + "Komargorod_pond_2013_G3.jpg",
    src: U + "thumb/5/5c/Komargorod_pond_2013_G3.jpg/3840px-Komargorod_pond_2013_G3.jpg" },
  { name: "blossoms", credit: "George Chernilevsky, public domain", page: C + "Apple-tree_blossoms_2017_G3.jpg",
    src: U + "thumb/8/86/Apple-tree_blossoms_2017_G3.jpg/3840px-Apple-tree_blossoms_2017_G3.jpg" },
  { name: "thistle", credit: "W.carter, CC0", page: C + "Common_Blue-Sow-Thistle_in_a_patch_of_sunlight.jpg",
    src: U + "c/ca/Common_Blue-Sow-Thistle_in_a_patch_of_sunlight.jpg" },
];

const CACHE = new URL("./.photos/", import.meta.url);
await mkdir(CACHE, { recursive: true });
async function photo(p) {
  const file = new URL(`${p.name}.jpg`, CACHE);
  let buf = await readFile(file).catch(() => null);
  if (!buf) {
    let res;
    for (let i = 1; (res = await fetch(p.src, { headers: { "User-Agent": "forensic-watermark-docs/0.1" } })).status === 429 && i <= 5; i++)
      await new Promise((r) => setTimeout(r, 10_000 * i));
    if (!res.ok) throw new Error(`${p.src}: HTTP ${res.status}`);
    await writeFile(file, (buf = Buffer.from(await res.arrayBuffer())));
  }
  return sharp(buf).rotate().resize(SIZE, SIZE, { fit: "cover" }).png().toBuffer();
}

const inputs = [];
for (const p of PHOTOS) inputs.push({ ...p, kind: "photo", data: await photo(p) }); // sequential: Wikimedia rate-limits bursts
for (const c of await corpus(SIZE, SIZE)) inputs.push({ ...c, kind: "stress" });

await mkdir(OUT, { recursive: true });
const raw = async (b) => (await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
const jpeg = (b) => sharp(b).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
const read = async (img) => {
  const t = performance.now();
  const r = await extract(img, { masterKey, imageId: "demo", verifyKeys });
  return { found: r.found, authentic: r.authentic, text: r.text, origin: r.origin, ms: Math.round(performance.now() - t) };
};

const examples = [];
for (const { name, note, kind, credit, page, data } of inputs) {
  const marked = await embed(data, { masterKey, imageId: "demo", payload, signingKey });

  // Difference map: |marked − original| per pixel, amplified 16× so it can be seen at all.
  const [a, b] = [await raw(data), await raw(marked.data)];
  const diff = Buffer.alloc(SIZE * SIZE);
  let peak = 0;
  for (let i = 0; i < diff.length; i++) {
    const d = Math.abs(b[i * 3] - a[i * 3]);
    peak = Math.max(peak, d);
    diff[i] = Math.min(255, d * 16);
  }

  // A "leaked" copy: crop 10% off the top-left, then re-save as JPEG q75.
  const c = Math.round(SIZE * 0.1);
  const leaked = await sharp(marked.data)
    .extract({ left: c, top: c, width: SIZE - c, height: SIZE - c })
    .jpeg({ quality: 75 }).toBuffer();

  await writeFile(new URL(`${name}-before.jpg`, OUT), await jpeg(data));
  await writeFile(new URL(`${name}-after.jpg`, OUT), await jpeg(marked.data));
  await writeFile(new URL(`${name}-diff.png`, OUT),
    await sharp(diff, { raw: { width: SIZE, height: SIZE, channels: 1 } }).png().toBuffer());
  await writeFile(new URL(`${name}-leaked.jpg`, OUT), leaked);

  examples.push({
    name, note, kind, credit, page,
    psnr: +marked.psnr.toFixed(1),
    peak,
    original: await read(data),
    marked: await read(marked.data),
    leaked: await read(leaked),
  });
  console.log(name, examples.at(-1));
}

await writeFile(new URL("examples.js", OUT), `window.EXAMPLES = ${JSON.stringify(examples, null, 2)};\n`);
