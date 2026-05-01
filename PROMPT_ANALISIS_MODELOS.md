# Prompt para Análisis Comparativo de Modelos Gemini

Copia y pega el siguiente prompt en **Gemini Ultra** (o Advanced) para obtener un análisis técnico profundo que nos ayude a decidir el mejor camino para Aura Scraper API.

---

## Prompt de Entrada

"Actúa como un Arquitecto de Soluciones Cloud experto en el ecosistema de Google Cloud y Vertex AI. Necesito realizar un análisis comparativo crítico de los modelos de la familia Gemini para un sistema de extracción de datos (web scraping) de alta precisión.

### El Caso de Uso:
Estamos operando una API de scraping de perfumes (Aura Scraper API). El flujo es:
1. Playwright extrae el texto bruto de un e-commerce.
2. Un LLM procesa ese texto para devolver un JSON estructurado (Zod Schema) con variantes, precios normalizados, notas olfativas y metadatos.
3. El LLM debe además realizar 'Copywriting' creativo para transformar descripciones técnicas en textos de marketing persuasivos.
4. Se realiza una segunda llamada para 'Search Grounding' buscando la URL de la imagen en Fragrantica.

### El Problema:
Estamos enfrentando 'Rate Limits' (Límites de Frecuencia) agresivos. Modelos como `gemini-2.5-pro` nos dan 0 RPM/RPD en ciertas capas, y `gemini-2.5-flash-lite` solo permite 20 peticiones diarias, lo cual es insuficiente para producción.

### Recursos Disponibles (Adjuntos):
[AQUÍ DEBES ADJUNTAR EL PDF: 'snkrs mens - Hoja 8.pdf']

### Tu Tarea:
Basado en el documento adjunto y tu conocimiento actualizado de las cuotas de Google AI Studio vs. Vertex AI, así como el mercado actual de LLMs, realiza lo siguiente:

1.  **Matriz de Selección Multimodelos:** 
    *   Identifica qué modelos de la lista de Google ofrecen el mejor balance entre RPM y RPD (Prioridad RPD > 500).
    *   Incluye alternativas de **Modelos Chinos y Open Source** de alto rendimiento que sean fácilmente integrables vía API (ej. DeepSeek-V3, Qwen-2.5-72B, Llama 3.3) a través de proveedores como Groq, Together AI, OpenRouter o DeepSeek API.
2.  **Evaluación de Capacidades Técnicas:** Compara la capacidad de `Gemini 1.5/2.5 Flash` vs `DeepSeek-V3` y `Qwen-2.5` para tareas de:
    *   Extracción de JSON estricto (Zod/Function Calling).
    *   Creatividad en Copywriting de lujo/perfumería.
    *   Soporte para contextos largos (extraemos el texto completo de la web).
3.  **Análisis de Costos y Escalabilidad:** 
    *   **ESTIMADO DE PRECIO POR REQUEST:** Calcula el costo aproximado de una extracción completa (asumiendo ~4,000 tokens de entrada y ~1,000 de salida) para cada modelo recomendado.
    *   ¿Es viable usar un modelo de la familia 'Gemma' o 'Llama' corriendo en infraestructura propia (GPU dedicada) vs pagar por token en APIs externas?
4.  **Veredicto Final:** Recomienda una combinación de modelos que sea **API-First** (fácil de conectar a una app Node.js) y que elimine el cuello de botella de las 20 peticiones diarias.

**Formato de respuesta:** Un reporte técnico estructurado con tablas comparativas, estimaciones de costos en USD y una recomendación final de implementación."
