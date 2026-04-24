import { getStaticWheelsCatalogData } from "./catalog-data-source.js";

const PART_XML_FIELD_ORDER = [
  "i",
  "pi",
  "t",
  "n",
  "p",
  "pp",
  "g",
  "di",
  "pdi",
  "b",
  "bn",
  "mn",
  "l",
  "mo",
  "hp",
  "tq",
  "wt",
  "cc",
  "ps",
];

function buildPartXmlNode(part) {
  const attrs = PART_XML_FIELD_ORDER.map((field) => `${field}='${part[field]}'`).join(" ");
  return `<p ${attrs}/>`;
}

// Generate wheel catalog matching the legacy client XML shape
function generateWheelCatalog() {
  const { wheelBrands, wheelGeneration, wheelPartOverrides } = getStaticWheelsCatalogData();
  const wheels = [];
  const smallestSize = wheelGeneration.sizes[0];
  let partId = wheelGeneration.basePartId;
  let designId = wheelGeneration.baseDesignId;

  for (const brand of wheelBrands) {
    for (let modelIndex = 0; modelIndex < wheelGeneration.modelsPerBrand; modelIndex++) {
      for (const size of wheelGeneration.sizes) {
        const gradeIndex = Math.min(Math.floor(modelIndex / 2), wheelGeneration.grades.length - 1);
        const sizeOffset = size - smallestSize;
        const basePrice =
          wheelGeneration.priceBase +
          sizeOffset * wheelGeneration.priceSizeStep +
          modelIndex * wheelGeneration.priceModelStep;

        const wheel = {
          i: partId,
          pi: 14,
          t: "c",
          n: `${brand.name} ${size}&quot;`,
          p: basePrice,
          pp: Math.floor(basePrice / 100),
          g: wheelGeneration.grades[gradeIndex],
          di: designId,
          pdi: designId,
          b: brand.slug,
          bn: brand.name,
          mn: String(partId),
          l: wheelGeneration.levelBase + modelIndex * wheelGeneration.levelStep,
          mo: 0,
          hp: 0,
          tq: 0,
          wt: sizeOffset * wheelGeneration.weightSizeStep,
          cc: 0,
          ps: size,
        };

        const override = wheelPartOverrides[String(partId)];
        if (override) {
          Object.assign(wheel, override);
        }

        wheels.push(wheel);

        partId++;
      }
      designId++;
    }
  }
  
  return wheels;
}

// Build XML for wheels and tires catalog matching the legacy client XML shape
export function buildWheelsTiresCatalogXml() {
  const { tires } = getStaticWheelsCatalogData();
  const tiresXml = tires.map(buildPartXmlNode).join("");
  const wheelsXml = generateWheelCatalog().map(buildPartXmlNode).join("");

  return `<p>${tiresXml}${wheelsXml}</p>`;
}
