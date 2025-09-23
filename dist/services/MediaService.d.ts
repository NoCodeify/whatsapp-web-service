export interface MediaUploadResult {
  url: string;
  filename: string;
  contentType: string;
  size: number;
  bucket: string;
}
export interface MediaFile {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size: number;
}
export declare class MediaService {
  private storage;
  private bucket;
  private maxFileSizeMB;
  constructor();
  /**
   * Upload media file to Cloud Storage
   */
  uploadMedia(
    file: MediaFile,
    userId: string,
    phoneNumber: string,
  ): Promise<MediaUploadResult>;
  /**
   * Download media from WhatsApp and upload to Cloud Storage
   */
  downloadAndUploadWhatsAppMedia(
    downloadFunction: () => Promise<Buffer>,
    mimetype: string,
    userId: string,
    phoneNumber: string,
  ): Promise<MediaUploadResult>;
  /**
   * Compress image for storage optimization
   */
  private compressImage;
  /**
   * Check if mimetype is an image
   */
  private isImage;
  /**
   * Get file extension from mimetype
   */
  private getFileExtension;
  /**
   * Generate thumbnail for video files (future enhancement)
   */
  generateVideoThumbnail(_buffer: Buffer): Promise<Buffer | null>;
  /**
   * Delete media file from Cloud Storage
   */
  deleteMedia(filename: string): Promise<void>;
}
//# sourceMappingURL=MediaService.d.ts.map
