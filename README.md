# 🔊 Lector de PDF en voz alta

Aplicación web para **leer libros en PDF en voz alta**, con voz femenina en
español o inglés y velocidad ajustable. Funciona enteramente en el navegador:
no necesita servidor ni instalación.

## ✨ Características

- 📂 Abre cualquier PDF desde tu equipo.
- 🗣️ Lectura en voz alta con **voz femenina** en **español** o **inglés**
  (usa las voces del sistema/navegador; las femeninas aparecen marcadas con ♀).
- ⏩ **Velocidad ajustable de 0.5x hasta 2.5x**.
- ▶ Botón para **iniciar la lectura desde la parte superior de lo que ves en
  pantalla** (según el scroll actual), no desde el principio del documento.
- ⏸ **Pausa** y ⏹ **Parar** en cualquier momento.
- 🟦 **Resalta el párrafo que se está leyendo** y desplaza la página para
  seguirlo.
- ⌨️ Atajo: barra espaciadora para leer / pausar.

## 🚀 Cómo usar

Como usa módulos y carga PDF.js, lo más sencillo es abrirlo con un servidor
local (recomendado por las restricciones de seguridad del navegador con
`file://`):

```bash
# Opción 1: Python
python3 -m http.server 8000

# Opción 2: Node
npx serve .
```

Luego abre `http://localhost:8000` en tu navegador.

> También puedes abrir `index.html` directamente, pero algunos navegadores
> bloquean la carga de archivos locales; usar un servidor local evita problemas.

### Pasos

1. Pulsa **📂 Abrir PDF** y selecciona tu libro.
2. Elige **Idioma** (Español / English) y la **Voz** que prefieras.
3. Ajusta la **Velocidad** con el deslizador.
4. Haz scroll hasta donde quieras empezar y pulsa **▶ Leer**.
5. Usa **⏸ Pausa** / **▶ Reanudar** o **⏹ Parar** cuando quieras.

## 🧩 Tecnología

- [PDF.js](https://mozilla.github.io/pdf.js/) para mostrar y extraer el texto.
- [Web Speech API](https://developer.mozilla.org/docs/Web/API/Web_Speech_API)
  (`speechSynthesis`) para la lectura en voz alta.

## ⚠️ Notas

- Las voces disponibles dependen de tu **sistema operativo y navegador**. Para
  obtener las mejores voces femeninas en español/inglés se recomienda
  **Google Chrome** o **Microsoft Edge** (incluyen voces neuronales de calidad).
- La lectura funciona con PDFs que contienen **texto seleccionable**. Los PDFs
  que son solo imágenes escaneadas (sin capa de texto) no se pueden leer sin OCR.
- Requiere conexión a Internet para cargar PDF.js desde el CDN.

## 📁 Estructura

```
.
├── index.html        # Estructura e interfaz
├── css/styles.css    # Estilos
├── js/app.js         # Lógica: render del PDF, párrafos, voz y resaltado
└── README.md
```
