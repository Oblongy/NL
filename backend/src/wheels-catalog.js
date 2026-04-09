// Wheels and Tires Catalog
// Based on wheel-lookup.json data and fixture format

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

// Generate wheel catalog matching the fixture format
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

// Build XML for wheels and tires catalog matching fixture format
export function buildWheelsTiresCatalogXml() {
  const wheels = generateWheelCatalog();
  
  const wheelsXml = wheels.map(w => 
    `<p i='${w.i}' pi='${w.pi}' t='${w.t}' n='${w.n}' p='${w.p}' pp='${w.pp}' g='${w.g}' ` +
    `di='${w.di}' pdi='${w.pdi}' b='${w.b}' bn='${w.bn}' mn='${w.mn}' l='${w.l}' mo='${w.mo}' ` +
    `hp='${w.hp}' tq='${w.tq}' wt='${w.wt}' cc='${w.cc}' ps='${w.ps}'/>`
  ).join("");
  
  return `<p>${wheelsXml}</p>`;
}
