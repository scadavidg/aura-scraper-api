import { z } from "zod";

export const PerfumeSchema = z.object({
  nombre: z.string().describe("El nombre completo del perfume"),
  handle: z.string().describe("Un slug único generado a partir del nombre, en minúsculas y con guiones (ej. parfums-de-marly-layton)"),
  coleccion: z.string().optional().describe("La colección a la que pertenece, usualmente el nombre de la marca (ej. Parfums De Marly)"),
  variantes: z.array(z.string()).describe("Lista de variantes disponibles excluyendo explícitamente cualquiera que contenga la palabra 'decant' o 'Decant' (ej. ['75 ML', '125 ML'])."),
  precios: z.array(z.number()).describe("Lista de precios regulares para cada variante (en el mismo orden). Usar formato numérico (ej. 460000)."),
  precios_descuento: z.array(z.number()).describe("Lista de precios con descuento para cada variante (mismo orden). Si no hay descuento, usar el mismo valor que el precio regular."),
  disponibilidad: z.array(z.enum(["Disponible", "Agotado"])).describe("Estado de disponibilidad para cada variante (mismo orden)."),
  descripcion: z.string().describe("La descripción completa o sinopsis del perfume"),
  genero: z.string().describe("Género del perfume (Masculino, Femenino, Unisex)"),
  clima: z.string().optional().describe("Climas ideales para el perfume, ej. 'Primavera, Otoño, Invierno'"),
  acordes: z.string().optional().describe("Acordes principales, ej. 'Especiado, Avainillado, Amaderado'"),
  concentracion: z.string().optional().describe("Concentración, ej. 'Eau de Parfum', 'Extrait de Parfum'"),
  pais: z.string().optional().describe("País de origen, ej. 'Francia'"),
  notas: z.string().optional().describe("Notas olfativas completas, separadas por comas"),
  año: z.number().optional().describe("Año de lanzamiento"),
  categoria: z.string().optional().describe("Categoría principal, ej. 'Nicho', 'Diseñador'"),
  image: z.string().optional().describe("URL de la imagen principal del perfume"),
  possibleImages: z.array(z.string()).optional().describe("Array de imágenes posibles encontradas con Tavily para que el usuario seleccione una"),
  sourceUrl: z.string().optional().describe("URL de la página de donde se extrajo el perfume"),
  sourceImageUrl: z.string().optional().describe("URL original de la imagen antes de optimizar, o 'manual upload'")
});

export type Perfume = z.infer<typeof PerfumeSchema>;