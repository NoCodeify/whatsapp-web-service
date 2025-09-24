"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaService = void 0;
const storage_1 = require("@google-cloud/storage");
const uuid_1 = require("uuid");
const jimp_1 = __importDefault(require("jimp"));
const pino_1 = __importDefault(require("pino"));
const logger = (0, pino_1.default)({ name: "MediaService" });
class MediaService {
    storage;
    bucket;
    maxFileSizeMB;
    constructor() {
        this.storage = new storage_1.Storage({
            projectId: process.env.GOOGLE_CLOUD_PROJECT,
        });
        this.bucket =
            process.env.MEDIA_BUCKET ||
                process.env.STORAGE_BUCKET ||
                "whatzai-whatsapp-media";
        this.maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || "16");
    }
    /**
     * Upload media file to Cloud Storage
     */
    async uploadMedia(file, userId, phoneNumber) {
        const uploadStartTime = Date.now();
        try {
            // Validate file size
            const maxSizeBytes = this.maxFileSizeMB * 1024 * 1024;
            if (file.size > maxSizeBytes) {
                throw new Error(`File size ${file.size} exceeds maximum ${maxSizeBytes} bytes`);
            }
            // Generate unique filename
            const fileExtension = this.getFileExtension(file.mimetype);
            const filename = `whatsapp-media/${userId}/${phoneNumber}/${Date.now()}_${(0, uuid_1.v4)()}${fileExtension}`;
            // Process image if needed (compress large images)
            let processedBuffer = file.buffer;
            if (this.isImage(file.mimetype) && file.size > 1024 * 1024) {
                // 1MB threshold
                processedBuffer = await this.compressImage(file.buffer, file.mimetype);
                logger.info({
                    userId,
                    phoneNumber,
                    originalSize: file.size,
                    compressedSize: processedBuffer.length,
                    compressionRatio: (file.size - processedBuffer.length) / file.size,
                }, "Image compressed for storage");
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
            const result = {
                url,
                filename,
                contentType: file.mimetype,
                size: processedBuffer.length,
                bucket: this.bucket,
            };
            logger.info({
                userId,
                phoneNumber,
                filename,
                contentType: file.mimetype,
                size: processedBuffer.length,
                uploadDuration: Date.now() - uploadStartTime,
            }, "Media uploaded successfully");
            return result;
        }
        catch (error) {
            logger.error({
                error,
                userId,
                phoneNumber,
                fileSize: file.size,
                mimetype: file.mimetype,
                uploadDuration: Date.now() - uploadStartTime,
            }, "Failed to upload media");
            throw error;
        }
    }
    /**
     * Download media from WhatsApp and upload to Cloud Storage
     */
    async downloadAndUploadWhatsAppMedia(downloadFunction, mimetype, userId, phoneNumber) {
        try {
            logger.info({ userId, phoneNumber, mimetype }, "Downloading media from WhatsApp");
            const buffer = await downloadFunction();
            const mediaFile = {
                buffer,
                mimetype,
                size: buffer.length,
                originalname: `whatsapp_media.${this.getFileExtension(mimetype)}`,
            };
            return await this.uploadMedia(mediaFile, userId, phoneNumber);
        }
        catch (error) {
            logger.error({ error, userId, phoneNumber, mimetype }, "Failed to download and upload WhatsApp media");
            throw error;
        }
    }
    /**
     * Compress image for storage optimization
     */
    async compressImage(buffer, mimetype) {
        try {
            const image = await jimp_1.default.read(buffer);
            // Resize if too large (max 1920px width/height)
            if (image.getWidth() > 1920 || image.getHeight() > 1920) {
                image.scaleToFit(1920, 1920);
            }
            // Compress based on format
            if (mimetype === "image/jpeg" || mimetype === "image/jpg") {
                image.quality(85); // JPEG quality
            }
            return await image.getBufferAsync(mimetype);
        }
        catch (error) {
            logger.warn({ error, mimetype }, "Failed to compress image, using original");
            return buffer;
        }
    }
    /**
     * Check if mimetype is an image
     */
    isImage(mimetype) {
        return mimetype.startsWith("image/");
    }
    /**
     * Get file extension from mimetype
     */
    getFileExtension(mimetype) {
        const extensions = {
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
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
            "text/plain": ".txt",
        };
        return extensions[mimetype] || ".bin";
    }
    /**
     * Generate thumbnail for video files (future enhancement)
     */
    async generateVideoThumbnail(_buffer) {
        // TODO: Implement video thumbnail generation using ffmpeg
        // For now, return null to indicate no thumbnail
        logger.info("Video thumbnail generation not implemented yet");
        return null;
    }
    /**
     * Delete media file from Cloud Storage
     */
    async deleteMedia(filename) {
        try {
            const bucket = this.storage.bucket(this.bucket);
            await bucket.file(filename).delete();
            logger.info({ filename }, "Media file deleted");
        }
        catch (error) {
            logger.error({ error, filename }, "Failed to delete media file");
            throw error;
        }
    }
}
exports.MediaService = MediaService;
//# sourceMappingURL=MediaService.js.map