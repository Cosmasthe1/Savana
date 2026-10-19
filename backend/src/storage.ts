import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { config } from './config.js';

const base = {
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
};

/** Used by the API and worker inside the network. */
export const s3 = new S3Client({ ...base, endpoint: config.S3_ENDPOINT });
/** Used only to presign URLs that the browser or headset will call. */
const presignClient = new S3Client({ ...base, endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT });

export const mediaUrl = (key: string) => `${config.PUBLIC_MEDIA_URL}/${key}`;

/** Browser-direct upload; the policy rejects wrong content types and oversized files at the storage layer. */
export function presignUpload(key: string, contentType: string) {
  return createPresignedPost(presignClient, {
    Bucket: config.S3_BUCKET,
    Key: key,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', 1, config.MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Expires: 3600,
  });
}
