// Wheels and Tires Catalog
// Based on wheel-lookup.json data and the legacy 10.0.03 catalog shape

// Tires catalog (pi=13)
const TIRES = [
  { i: 1300, n: 'Nitto NT450 Street Tire', p: 300, pp: 3, g: 'C', l: 100, ps: 0 },
  { i: 1301, n: 'Nitto NT555 Performance Tire', p: 650, pp: 6, g: 'C', l: 100, ps: 5 },
  { i: 1302, n: 'Nitto NT555R Drag Radial', p: 1400, pp: 14, g: 'C', l: 200, ps: 8 },
  { i: 1303, n: 'Nitto NT05 Competition Tire', p: 2800, pp: 28, g: 'B', l: 300, ps: 10 },
  { i: 1304, n: 'Nitto NT01 Track Tire', p: 5200, pp: 52, g: 'B', l: 400, ps: 12 },
  { i: 1305, n: 'Nitto Invo Max Performance Tire', p: 9000, pp: 90, g: 'A', l: 500, ps: 15 },
];

export const WHEEL_BRANDS = [
  { id: 1, name: "Konig", slug: "konig" },
  { id: 2, name: "Enkei", slug: "enkei" },
  { id: 3, name: "BBS", slug: "bbs" },
  { id: 4, name: "Volk Racing", slug: "volkracing" },
  { id: 5, name: "Work Wheels", slug: "workwheels" },
  { id: 6, name: "Rotiform", slug: "rotiform" },
  { id: 7, name: "HRE", slug: "hre" },
  { id: 8, name: "OZ Racing", slug: "ozracing" },
];

// Generate wheel catalog matching the legacy client XML shape
function generateWheelCatalog() {
  const wheels = [];
  const sizes = [15, 16, 17, 18, 19, 20];
  const grades = ["C", "B", "A", "S"];
  
  let partId = 1000;
  let designId = 1;
  
  for (const brand of WHEEL_BRANDS) {
    for (let i = 0; i < 5; i++) {
      for (const size of sizes) {
        const gradeIndex = Math.min(Math.floor(i / 2), grades.length - 1);
        const grade = grades[gradeIndex];
        const level = 100 + i * 100;
        const basePrice = 500 + (size - 15) * 200 + i * 1000;
        const weightDelta = -(size - 15) * 2;
        
        wheels.push({
          i: partId,
          pi: 14,
          t: 'c',
          n: `${brand.name} ${size}"`,
          p: basePrice,
          pp: Math.floor(basePrice / 100),
          g: grade,
          di: designId,
          pdi: designId,
          b: brand.slug,
          bn: brand.name,
          mn: String(partId),
          l: level,
          mo: 0,
          hp: 0,
          tq: 0,
          wt: weightDelta,
          cc: 0,
          ps: size,
        });
        
        partId++;
      }
      designId++;
    }
  }
  
  return wheels;
}

// Build XML for wheels and tires catalog matching the legacy client XML shape
export function buildWheelsTiresCatalogXml() {
  // Start with tires (pi=13)
  const tiresXml = TIRES.map(t => 
    `<p i='${t.i}' pi='13' t='c' n='${t.n}' p='${t.p}' pp='${t.pp}' g='${t.g}' di='${t.i - 1299}' pdi='${t.i - 1299}' ` +
    `b='nitto' bn='Nitto' mn='NT${t.i - 1299}' l='${t.l}' mo='0' hp='0' tq='0' wt='0' cc='0' ps='${t.ps}'/>`
  ).join("");
  
  // Then add wheels (pi=14)
  const wheels = generateWheelCatalog();
  const wheelsXml = wheels.map(w => 
    `<p i='${w.i}' pi='${w.pi}' t='${w.t}' n='${w.n}' p='${w.p}' pp='${w.pp}' g='${w.g}' ` +
    `di='${w.di}' pdi='${w.pdi}' b='${w.b}' bn='${w.bn}' mn='${w.mn}' l='${w.l}' mo='${w.mo}' ` +
    `hp='${w.hp}' tq='${w.tq}' wt='${w.wt}' cc='${w.cc}' ps='${w.ps}'/>`
  ).join("");
  
  return `<p>${tiresXml}${wheelsXml}</p>`;
}
