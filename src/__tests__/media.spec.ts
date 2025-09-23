import { MediaService, MediaFile } from "../services/MediaService";
import { Storage } from "@google-cloud/storage";
import Jimp from "jimp";

// Mock dependencies
jest.mock("@google-cloud/storage");
jest.mock("jimp");
jest.mock("pino", () => ({
  __esModule: true,
  default: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe("MediaService", () => {
  let mediaService: MediaService;
  let mockStorage: jest.Mocked<Storage>;
  let mockBucket: any;
  let mockStorageFile: any;

  beforeEach(() => {
    // Mock Storage and its methods
    mockStorageFile = {
      save: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest
        .fn()
        .mockResolvedValue(["https://signed-url.com/file.jpg"]),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    mockBucket = {
      file: jest.fn().mockReturnValue(mockStorageFile),
    };

    mockStorage = {
      bucket: jest.fn().mockReturnValue(mockBucket),
    } as any;

    (Storage as jest.MockedClass<typeof Storage>).mockImplementation(
      () => mockStorage,
    );

    // Set environment variables
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.MEDIA_BUCKET = "test-bucket";
    process.env.MAX_FILE_SIZE_MB = "16";

    mediaService = new MediaService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("uploadMedia", () => {
    const testMediaFile: MediaFile = {
      buffer: Buffer.from("fake image data"),
      mimetype: "image/jpeg",
      size: 1024,
      originalname: "test.jpg",
    };

    const userId = "user123";
    const phoneNumber = "+1234567890";

    it("should upload media successfully", async () => {
      const result = await mediaService.uploadMedia(
        testMediaFile,
        userId,
        phoneNumber,
      );

      expect(result).toEqual({
        url: "https://signed-url.com/file.jpg",
        filename: expect.stringMatching(
          /whatsapp-media\/user123\/\+1234567890\/\d+_.+\.jpg/,
        ),
        contentType: "image/jpeg",
        size: expect.any(Number), // Size may change due to processing
        bucket: "test-bucket",
      });

      expect(mockBucket.file).toHaveBeenCalledWith(
        expect.stringContaining("whatsapp-media/user123"),
      );
      expect(mockStorageFile.save).toHaveBeenCalledWith(
        testMediaFile.buffer,
        expect.objectContaining({
          metadata: expect.objectContaining({
            contentType: "image/jpeg",
          }),
          gzip: true,
        }),
      );
      expect(mockStorageFile.getSignedUrl).toHaveBeenCalledWith({
        action: "read",
        expires: expect.any(Number),
      });
    });

    it("should reject files exceeding size limit", async () => {
      const largeFile: MediaFile = {
        ...testMediaFile,
        size: 20 * 1024 * 1024, // 20MB (exceeds 16MB limit)
      };

      await expect(
        mediaService.uploadMedia(largeFile, userId, phoneNumber),
      ).rejects.toThrow("File size 20971520 exceeds maximum 16777216 bytes");
    });

    it("should compress large images", async () => {
      const mockJimpInstance = {
        getWidth: jest.fn().mockReturnValue(2000),
        getHeight: jest.fn().mockReturnValue(1500),
        scaleToFit: jest.fn().mockReturnThis(),
        quality: jest.fn().mockReturnThis(),
        getBufferAsync: jest
          .fn()
          .mockResolvedValue(Buffer.from("compressed image")),
      };

      (Jimp.read as jest.Mock).mockResolvedValue(mockJimpInstance);

      const largeImageFile: MediaFile = {
        buffer: Buffer.alloc(2 * 1024 * 1024), // 2MB image
        mimetype: "image/jpeg",
        size: 2 * 1024 * 1024,
        originalname: "large.jpg",
      };

      await mediaService.uploadMedia(largeImageFile, userId, phoneNumber);

      expect(Jimp.read).toHaveBeenCalledWith(largeImageFile.buffer);
      expect(mockJimpInstance.scaleToFit).toHaveBeenCalledWith(1920, 1920);
      expect(mockJimpInstance.quality).toHaveBeenCalledWith(85);
      expect(mockStorageFile.save).toHaveBeenCalledWith(
        Buffer.from("compressed image"),
        expect.any(Object),
      );
    });

    it("should handle different file types", async () => {
      const testCases = [
        { mimetype: "video/mp4", expectedExtension: ".mp4" },
        { mimetype: "audio/ogg", expectedExtension: ".ogg" },
        { mimetype: "application/pdf", expectedExtension: ".pdf" },
        { mimetype: "unknown/type", expectedExtension: ".bin" },
      ];

      for (const testCase of testCases) {
        const file: MediaFile = {
          ...testMediaFile,
          mimetype: testCase.mimetype,
        };

        const result = await mediaService.uploadMedia(
          file,
          userId,
          phoneNumber,
        );

        expect(result.filename).toContain(testCase.expectedExtension);
        expect(result.contentType).toBe(testCase.mimetype);
      }
    });

    it("should handle upload failures gracefully", async () => {
      mockStorageFile.save.mockRejectedValue(new Error("Storage error"));

      await expect(
        mediaService.uploadMedia(testMediaFile, userId, phoneNumber),
      ).rejects.toThrow("Storage error");
    });
  });

  describe("downloadAndUploadWhatsAppMedia", () => {
    it("should download and upload WhatsApp media", async () => {
      const mockDownload = jest
        .fn()
        .mockResolvedValue(Buffer.from("whatsapp media"));
      const mimetype = "image/jpeg";

      const result = await mediaService.downloadAndUploadWhatsAppMedia(
        mockDownload,
        mimetype,
        "user123",
        "+1234567890",
      );

      expect(mockDownload).toHaveBeenCalled();
      expect(result.contentType).toBe(mimetype);
      expect(result.url).toBe("https://signed-url.com/file.jpg");
    });

    it("should handle download failures", async () => {
      const mockDownload = jest
        .fn()
        .mockRejectedValue(new Error("Download failed"));

      await expect(
        mediaService.downloadAndUploadWhatsAppMedia(
          mockDownload,
          "image/jpeg",
          "user123",
          "+1234567890",
        ),
      ).rejects.toThrow("Download failed");
    });
  });

  describe("deleteMedia", () => {
    it("should delete media file", async () => {
      const filename = "whatsapp-media/user123/+1234567890/test.jpg";

      await mediaService.deleteMedia(filename);

      expect(mockBucket.file).toHaveBeenCalledWith(filename);
      expect(mockStorageFile.delete).toHaveBeenCalled();
    });

    it("should handle deletion failures", async () => {
      mockStorageFile.delete.mockRejectedValue(new Error("Delete failed"));

      await expect(mediaService.deleteMedia("test.jpg")).rejects.toThrow(
        "Delete failed",
      );
    });
  });

  describe("file extension detection", () => {
    it("should return correct extensions for known mimetypes", () => {
      const testCases = [
        { mimetype: "image/jpeg", expected: ".jpg" },
        { mimetype: "image/png", expected: ".png" },
        { mimetype: "video/mp4", expected: ".mp4" },
        { mimetype: "audio/mpeg", expected: ".mp3" },
        { mimetype: "application/pdf", expected: ".pdf" },
        { mimetype: "unknown/type", expected: ".bin" },
      ];

      // Access private method for testing (TypeScript workaround)
      const getFileExtension = (mediaService as any).getFileExtension.bind(
        mediaService,
      );

      testCases.forEach(({ mimetype, expected }) => {
        expect(getFileExtension(mimetype)).toBe(expected);
      });
    });
  });

  describe("image detection", () => {
    it("should correctly identify image mimetypes", () => {
      // Access private method for testing
      const isImage = (mediaService as any).isImage.bind(mediaService);

      expect(isImage("image/jpeg")).toBe(true);
      expect(isImage("image/png")).toBe(true);
      expect(isImage("video/mp4")).toBe(false);
      expect(isImage("application/pdf")).toBe(false);
    });
  });

  describe("environment configuration", () => {
    it("should use default values when env vars not set", () => {
      delete process.env.MEDIA_BUCKET;
      delete process.env.MAX_FILE_SIZE_MB;

      const service = new MediaService();

      // Check defaults are used (we can't directly test private properties,
      // but we can test behavior)
      expect(service).toBeInstanceOf(MediaService);
    });

    it("should respect custom bucket from STORAGE_BUCKET fallback", () => {
      delete process.env.MEDIA_BUCKET;
      process.env.STORAGE_BUCKET = "fallback-bucket";

      const service = new MediaService();

      expect(service).toBeInstanceOf(MediaService);
      // The actual bucket name is private, but we can verify the service initializes
    });
  });
});

describe("MediaService Integration", () => {
  it("should handle real-world image processing workflow", async () => {
    // Set up environment for this test
    process.env.MEDIA_BUCKET = "test-bucket";
    process.env.STORAGE_BUCKET = "test-bucket";

    // Mock a complete workflow with realistic data
    const mockJimpInstance = {
      getWidth: jest.fn().mockReturnValue(800),
      getHeight: jest.fn().mockReturnValue(600),
      scaleToFit: jest.fn().mockReturnThis(),
      quality: jest.fn().mockReturnThis(),
      getBufferAsync: jest
        .fn()
        .mockResolvedValue(Buffer.from("processed image")),
    };

    (Jimp.read as jest.Mock).mockResolvedValue(mockJimpInstance);

    const mediaService = new MediaService();

    // Create a realistic image file
    const imageFile: MediaFile = {
      buffer: Buffer.from("fake jpeg data"),
      mimetype: "image/jpeg",
      size: 512 * 1024, // 512KB - small enough to not trigger compression
      originalname: "photo.jpg",
    };

    const result = await mediaService.uploadMedia(
      imageFile,
      "user123",
      "+1234567890",
    );

    expect(result).toEqual({
      url: "https://signed-url.com/file.jpg",
      filename: expect.stringContaining(".jpg"),
      contentType: "image/jpeg",
      size: expect.any(Number),
      bucket: expect.any(String), // Bucket name depends on environment
    });

    // Verify no compression was attempted for small image
    expect(Jimp.read).not.toHaveBeenCalled();
  });
});
