import sharp from 'sharp';

/**
 * Optimiza una imagen para el catálogo:
 *  - Corrige la orientación EXIF (rotate)
 *  - Ancho máximo 600px, manteniendo proporción (sin recortar)
 *  - No agrande imágenes pequeñas
 *  - Convierte a WebP calidad 80
 */
export function optimizarImagen(bytes) {
  return sharp(bytes)
    .rotate()
    .resize({
      width: 600,
      height: null,
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer();
}
