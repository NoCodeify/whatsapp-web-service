import { Storage } from "@google-cloud/storage";
import { v4 as uuidv4 } from "uuid";
import Jimp from "jimp";
import pino from "pino";

const logger = pino({ name: "MediaService" });

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

export class MediaService {
  private storage: Storage;
  private bucket: string;
  private maxFileSizeMB: number;

  constructor() {
    this.storage = new Storage({
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });

    // Determine which bucket to use with fallback logic
    if (process.env.MEDIA_BUCKET) {
      this.bucket = process.env.MEDIA_BUCKET;
      logger.info(
        { bucket: this.bucket, source: "MEDIA_BUCKET" },
        "Using dedicated media storage bucket",
      );
    } else if (process.env.STORAGE_BUCKET) {
      this.bucket = process.env.STORAGE_BUCKET;
      logger.warn(
        { bucket: this.bucket },
        "MEDIA_BUCKET not set, using STORAGE_BUCKET for media files. Consider setting MEDIA_BUCKET for better separation.",
      );
    } else {
      this.bucket = "whatzai-whatsapp-media";
      logger.warn(
        { bucket: this.bucket },
        "No bucket configured, using default bucket. Set MEDIA_BUCKET or STORAGE_BUCKET environment variable.",
      );
    }

    this.maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || "16");

    logger.info(
      {
        bucket: this.bucket,
        projectId: process.env.GOOGLE_CLOUD_PROJECT,
        maxFileSizeMB: this.maxFileSizeMB,
      },
      "MediaService initialized",
    );
  }

  /**
   * Upload media file to Cloud Storage
   */
  async uploadMedia(
    file: MediaFile,
    userId: string,
    phoneNumber: string,
  ): Promise<MediaUploadResult> {
    const uploadStartTime = Date.now();

    try {
      // Validate file size
      const maxSizeBytes = this.maxFileSizeMB * 1024 * 1024;
      if (file.size > maxSizeBytes) {
        throw new Error(
          `File size ${file.size} exceeds maximum ${maxSizeBytes} bytes`,
        );
      }

      // Generate unique filename
      const fileExtension = this.getFileExtension(file.mimetype);
      const filename = `whatsapp-media/${userId}/${phoneNumber}/${Date.now()}_${uuidv4()}${fileExtension}`;

      // Process image if needed (compress large images)
      let processedBuffer = file.buffer;
      if (this.isImage(file.mimetype) && file.size > 1024 * 1024) {
        // 1MB threshold
        processedBuffer = await this.compressImage(file.buffer, file.mimetype);
        logger.info(
          {
            userId,
            phoneNumber,
            originalSize: file.size,
            compressedSize: processedBuffer.length,
            compressionRatio: (file.size - processedBuffer.length) / file.size,
          },
          "Image compressed for storage",
        );
      }

      // Upload to Cloud Storage
      const bucket = this.storage.bucket(this.bucket);
      const fileObject = bucket.file(filename);

      await fileObject.save(processedBuffer, {
        metadata: {
          contentType: file.mimetype,
          metadata: {
            userId,
            phoneNumber,
            originalName: file.originalname || "unknown",
            uploadedAt: new Date().toISOString(),
          },
        },
        gzip: true,
      });

      // Make file publicly accessible with signed URL (expires in 7 days)
      const [url] = await fileObject.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      const result: MediaUploadResult = {
        url,
        filename,
        contentType: file.mimetype,
        size: processedBuffer.length,
        bucket: this.bucket,
      };

      logger.info(
        {
          userId,
          phoneNumber,
          filename,
          contentType: file.mimetype,
          size: processedBuffer.length,
          uploadDuration: Date.now() - uploadStartTime,
        },
        "Media uploaded successfully",
      );

      return result;
    } catch (error: any) {
      logger.error(
        {
          error: {
            message: error.message,
            code: error.code,
            name: error.name,
            stack: error.stack,
          },
          userId,
          phoneNumber,
          fileSize: file.size,
          mimetype: file.mimetype,
          uploadDuration: Date.now() - uploadStartTime,
          bucketName: this.bucket,
          projectId: process.env.GOOGLE_CLOUD_PROJECT,
        },
        "Failed to upload media",
      );
      throw error;
    }
  }

  /**
   * Download media from WhatsApp and upload to Cloud Storage
   */
  async downloadAndUploadWhatsAppMedia(
    downloadFunction: () => Promise<Buffer>,
    mimetype: string,
    userId: string,
    phoneNumber: string,
  ): Promise<MediaUploadResult> {
    try {
      logger.info(
        { userId, phoneNumber, mimetype },
        "Downloading media from WhatsApp",
      );

      const buffer = await downloadFunction();

      const mediaFile: MediaFile = {
        buffer,
        mimetype,
        size: buffer.length,
        originalname: `whatsapp_media.${this.getFileExtension(mimetype)}`,
      };

      return await this.uploadMedia(mediaFile, userId, phoneNumber);
    } catch (error: any) {
      logger.error(
        {
          error: {
            message: error.message,
            code: error.code,
            name: error.name,
          },
          userId,
          phoneNumber,
          mimetype,
        },
        "Failed to download and upload WhatsApp media",
      );
      throw error;
    }
  }

  /**
   * Compress image for storage optimization
   */
  private async compressImage(
    buffer: Buffer,
    mimetype: string,
  ): Promise<Buffer> {
    try {
      const image = await Jimp.read(buffer);

      // Resize if too large (max 1920px width/height)
      if (image.getWidth() > 1920 || image.getHeight() > 1920) {
        image.scaleToFit(1920, 1920);
      }

      // Compress based on format
      if (mimetype === "image/jpeg" || mimetype === "image/jpg") {
        image.quality(85); // JPEG quality
      }

      return await image.getBufferAsync(mimetype as any);
    } catch (error) {
      logger.warn(
        { error, mimetype },
        "Failed to compress image, using original",
      );
      return buffer;
    }
  }

  /**
   * Check if mimetype is an image
   */
  private isImage(mimetype: string): boolean {
    return mimetype.startsWith("image/");
  }

  /**
   * Get file extension from mimetype
   */
  private getFileExtension(mimetype: string): string {
    const extensions: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/webm": ".webm",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "audio/ogg": ".ogg",
      "application/pdf": ".pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        ".docx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        ".xlsx",
      "text/plain": ".txt",
    };

    return extensions[mimetype] || ".bin";
  }

  /**
   * Generate thumbnail for video files (future enhancement)
   */
  async generateVideoThumbnail(_buffer: Buffer): Promise<Buffer | null> {
    // TODO: Implement video thumbnail generation using ffmpeg
    // For now, return null to indicate no thumbnail
    logger.info("Video thumbnail generation not implemented yet");
    return null;
  }

  /**
   * Delete media file from Cloud Storage
   */
  async deleteMedia(filename: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucket);
      await bucket.file(filename).delete();
      logger.info({ filename }, "Media file deleted");
    } catch (error: any) {
      logger.error(
        {
          error: {
            message: error.message,
            code: error.code,
            name: error.name,
          },
          filename,
          bucketName: this.bucket,
        },
        "Failed to delete media file",
      );
      throw error;
    }
  }
}
