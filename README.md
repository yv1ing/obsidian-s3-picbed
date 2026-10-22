# S3 Picbed

S3 Picbed uploads images from Obsidian notes to an S3-compatible bucket. Paste an image into a note and the plugin stores it with a timestamp name, then inserts a Markdown link.

## Features

- Upload one or several pasted images at once.
- Objects are named with a timestamp and the file extension, with an optional prefix.
- Links use the endpoint, a custom public domain, or a signed URL that expires in 1 hour.
- Delete one image or all images in the configured bucket from the editor's right-click menu.
- Test the endpoint, bucket, region and credentials from the settings page.

## Installation

Copy `main.js`, `manifest.json` and `styles.css` into:

```text
<vault>/.obsidian/plugins/s3-picbed/
```

Then enable **S3 Picbed** under **Settings → Community plugins**.

## Settings

| Setting | Description |
| --- | --- |
| Endpoint | S3 API endpoint |
| Bucket | Bucket name |
| Region | Required signing region |
| Access key ID | S3 access key ID |
| Secret access key | S3 secret access key |
| Prefix | Optional key prefix |
| Public URL | Optional public domain |
| Use signed URL | Private bucket; links expire in 1 hour |

The plugin has no default settings. Endpoint, bucket, region, access key ID and secret access key are required.

If signed URLs are off, `Public URL` sets the prefix for Markdown links. Use it when images are served from a different domain than the API endpoint. Do not include a filename.

## Addressing

S3 providers put the bucket in different parts of the request URL. If the endpoint host is the bucket name or begins with the bucket name and a dot, S3 Picbed uses virtual-hosted requests. Otherwise it uses path-style requests.

```text
Path-style:      https://s3.example.com/<bucket>/<key>
Virtual-hosted:  https://<bucket>.s3.example.com/<key>
```

If a provider only accepts virtual-hosted requests, add the bucket to the endpoint host.

### Provider examples

```text
AWS S3
Endpoint:   https://<bucket>.s3.us-east-1.amazonaws.com
Region:     us-east-1

Cloudflare R2
Endpoint:   https://<account>.r2.cloudflarestorage.com
Region:     auto
Public URL: https://pub-xxxxxxxx.r2.dev

Aliyun OSS
Endpoint:   https://<bucket>.s3.oss-cn-hangzhou.aliyuncs.com
Region:     cn-hangzhou
Public URL: https://<bucket>.oss-cn-hangzhou.aliyuncs.com

MinIO
Endpoint:   http://localhost:9000
Region:     us-east-1
```

## Notes

- Signed links expire after 1 hour. For images that should stay visible, use a public bucket or a CDN.
- The bucket must already exist.
- The connection test sends a `HeadBucket` request and does not write to the bucket. The key needs bucket-level permission such as `s3:ListBucket` or `oss:HeadBucket`.

## Development

```bash
npm install
npm run dev
npm run build
```

The build runs a strict TypeScript check, then writes `main.js`.

## License

MIT
