import { Perfume } from "./schema";

/**
 * Maps Perfume (scraper output) to Medusa product format.
 * Handles variants, prices, images, and metadata.
 */
function toTitleCase(s: string): string {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export function mapPerfumeToMedusaProduct(perfume: Perfume) {
  return {
    title: toTitleCase(perfume.nombre),
    handle: perfume.handle,
    description: perfume.descripcion,
    type_id: null,
    collection_id: null,
    images: perfume.image ? [{ url: perfume.image }] : [],
    thumbnail: perfume.image || null,
    variants: perfume.variantes.map((variant, index) => ({
      title: variant,
      sku: `${perfume.handle}-${variant.toLowerCase().replace(/\s+/g, "-")}`,
      prices: [
        {
          currency_code: "cop",
          amount: perfume.precios[index] || 0,
        },
      ],
      options: perfume.variantes.length > 1 ? [
        {
          option_id: "perfume_size",
          value: variant,
        },
      ] : [],
      manage_inventory: true,
      inventory_quantity: perfume.disponibilidad[index] === "Disponible" ? 100 : 0,
    })),
    tags: buildTags(perfume),
    categories: [],
    metadata: {
      genero: perfume.genero || null,
      clima: perfume.clima || null,
      acordes: perfume.acordes || null,
      concentracion: perfume.concentracion || null,
      pais: perfume.pais || null,
      notas: perfume.notas || null,
      año: perfume.año || null,
      categoria: perfume.categoria || null,
      coleccion: perfume.coleccion || null,
    },
  };
}

/** Split on top-level commas only — ignores commas inside parentheses. */
function splitTopLevel(s?: string): string[] {
  if (!s) return [];
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) result.push(last);
  return result;
}

function buildTags(perfume: Perfume): string[] {
  const tags: string[] = [];

  if (perfume.concentracion) {
    const concNorm = perfume.concentracion
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9]/g, "");
    tags.push(`tag_concentracion_${concNorm}`);
  }

  if (perfume.acordes) {
    splitTopLevel(perfume.acordes).forEach((a) => {
      const norm = a
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9]/g, "");
      tags.push(`tag_acorde_${norm}`);
    });
  }

  if (perfume.clima) {
    splitTopLevel(perfume.clima).forEach((c) => {
      const norm = c
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[\s()]+/g, "")
        .replace(/[^a-z0-9]/g, "");
      tags.push(`tag_clima_${norm}`);
    });
  }

  return tags;
}
