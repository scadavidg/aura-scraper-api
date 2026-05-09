import { Perfume } from "./schema";

/**
 * Maps Perfume (scraper output) to Medusa product format.
 * Handles variants, prices, images, and metadata.
 */
export function mapPerfumeToMedusaProduct(perfume: Perfume) {
  return {
    title: perfume.nombre,
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

function buildTags(perfume: Perfume): string[] {
  const tags: string[] = [];

  if (perfume.genero) {
    tags.push(`genero_${perfume.genero.toLowerCase()}`);
  }

  if (perfume.concentracion) {
    const concNorm = perfume.concentracion
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    tags.push(`concentracion_${concNorm}`);
  }

  if (perfume.categoria) {
    tags.push(`categoria_${perfume.categoria.toLowerCase().replace(/\s+/g, "_")}`);
  }

  if (perfume.clima) {
    perfume.clima
      .split(",")
      .map((c) => c.trim().toLowerCase().replace(/\s+/g, "_"))
      .forEach((c) => tags.push(`clima_${c}`));
  }

  return tags;
}
