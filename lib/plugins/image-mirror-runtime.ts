import {
  ImageMirrorService,
  createHttpImageMirrorObjectStore,
  type ImageMirrorInput,
  type ImageMirrorRecord,
} from "@/lib/plugins/image-mirror";
import { getMongoImageMirrorRepository } from "@/lib/plugins/mongo-image-mirror";

interface ImageMirrorRuntime {
  readonly service: ImageMirrorService;
}

const globalForImageMirror = globalThis as typeof globalThis & {
  __kerkerkerImageMirrorRuntime?: Promise<ImageMirrorRuntime | null>;
};

function env(name: string): string {
  return (process.env[name] || "").trim();
}

/**
 * Creates the host-owned image mirror lazily. Missing R2 configuration is a
 * supported local/degraded mode; callers keep the source URL in that case.
 */
export async function getImageMirrorRuntime(): Promise<ImageMirrorRuntime | null> {
  if (!env("CLOUDFLARE_R2_PUBLIC_URL") || !env("CLOUDFLARE_R2_UPLOAD_API_URL") || !env("CLOUDFLARE_R2_UPLOAD_API_TOKEN")) {
    return null;
  }
  if (!globalForImageMirror.__kerkerkerImageMirrorRuntime) {
    globalForImageMirror.__kerkerkerImageMirrorRuntime = (async () => {
      const repository = await getMongoImageMirrorRepository();
      const objectStore = createHttpImageMirrorObjectStore({
        uploadApiUrl: env("CLOUDFLARE_R2_UPLOAD_API_URL"),
        publicBaseUrl: env("CLOUDFLARE_R2_PUBLIC_URL"),
        token: env("CLOUDFLARE_R2_UPLOAD_API_TOKEN"),
      });
      return {
        service: new ImageMirrorService({
          repository,
          objectStore,
          maxImageBytes: Number(env("CLOUDFLARE_R2_MAX_IMAGE_BYTES") || 10 * 1024 * 1024),
        }),
      };
    })().catch((error) => {
      console.warn("初始化图片镜像服务失败:", error instanceof Error ? error.name : "unknown");
      globalForImageMirror.__kerkerkerImageMirrorRuntime = Promise.resolve(null);
      return null;
    });
  }
  return globalForImageMirror.__kerkerkerImageMirrorRuntime;
}

/** Mirror one source image when the host identity and R2 policy are ready. */
export async function mirrorImageUrl(input: ImageMirrorInput): Promise<string> {
  const runtime = await getImageMirrorRuntime();
  if (!runtime) return input.originalUrl;
  try {
    const record: ImageMirrorRecord = await runtime.service.mirror(input);
    return record.mirrorUrl || input.originalUrl;
  } catch (error) {
    console.warn("图片镜像失败，继续返回来源地址:", error instanceof Error ? error.name : "unknown");
    return input.originalUrl;
  }
}
