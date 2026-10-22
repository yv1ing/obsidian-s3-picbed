import { MarkdownView, Menu, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type { App, Editor } from "obsidian";

interface S3PicbedSettings {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    publicUrl: string;
    useSignedUrl?: boolean;
}

type TextSettingKey = Exclude<keyof S3PicbedSettings, "useSignedUrl">;

const EMPTY_SETTINGS: S3PicbedSettings = {
    endpoint: "",
    bucket: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "",
    publicUrl: "",
};

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const textEncoder = new TextEncoder();
let lastTimestamp = 0;

const nextTimestamp = (): number => {
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
    return lastTimestamp;
};

const toHex = (data: ArrayBuffer | Uint8Array): string => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return Array.from(bytes, byte => (byte < 16 ? "0" : "") + byte.toString(16)).join("");
};

const sha256 = async (data: string | ArrayBuffer | Uint8Array): Promise<string> =>
    toHex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? textEncoder.encode(data) : data));

const hmac = async (key: Uint8Array, data: string): Promise<Uint8Array> => {
    const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", imported, textEncoder.encode(data)));
};

const amzDate = (): string => new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");

const rfc3986 = (value: string): string =>
    encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

const encodeKey = (key: string): string => key.split("/").map(rfc3986).join("/");

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;
const isImageFile = (file: File): boolean => file.type.startsWith("image/") || IMAGE_EXTENSION.test(file.name);

const urlFromMarkdown = (value: string): string => {
    const trimmed = value.trim();
    const angled = trimmed.match(/^<([^>]+)>/);
    return angled ? angled[1] : trimmed.split(/\s+/)[0];
};

const imageMatches = (text: string): RegExpExecArray[] => {
    const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) matches.push(match);
    return matches;
};

class S3Client {
    private origin: string;
    private host: string;
    private objectPath: string;
    private objectBase: string;
    private urlBases: string[];
    private region: string;
    private prefix: string;
    private publicBase: string;
    private accessKeyId: string;
    private secretAccessKey: string;
    private useSignedUrl: boolean;

    constructor(settings: S3PicbedSettings) {
        const endpoint = settings.endpoint.trim();
        const bucket = settings.bucket.trim();
        const region = settings.region.trim();
        this.accessKeyId = settings.accessKeyId.trim();
        this.secretAccessKey = settings.secretAccessKey.trim();
        if (!endpoint || !bucket || !region || !this.accessKeyId || !this.secretAccessKey) {
            throw new Error("Endpoint, bucket, region and keys are required");
        }

        const url = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
        const basePath = url.pathname.replace(/\/+$/, "");
        const virtualHosted = url.hostname === bucket || url.hostname.startsWith(`${bucket}.`);

        this.host = url.host;
        this.origin = `${url.protocol}//${this.host}`;
        const lastSegment = basePath.split("/").pop();
        const bucketInPath = lastSegment === bucket || lastSegment === rfc3986(bucket);
        this.objectPath = virtualHosted || bucketInPath ? basePath : `${basePath}/${rfc3986(bucket)}`;
        this.objectBase = `${this.origin}${this.objectPath}`;
        this.region = region;
        this.prefix = settings.prefix.trim().replace(/^\/+|\/+$/g, "");
        this.publicBase = this.normalizePublicBase(settings.publicUrl);
        this.urlBases = [this.publicBase, this.objectBase]
            .filter(Boolean)
            .sort((a, b) => new URL(b).pathname.length - new URL(a).pathname.length);
        this.useSignedUrl = !!settings.useSignedUrl;
    }

    async upload(file: File): Promise<string> {
        const key = this.createKey(file);
        const body = await file.arrayBuffer();
        await this.sendRequest("PUT", this.pathFor(key), body, file.type || "application/octet-stream");
        return this.urlForKey(key);
    }

    async delete(key: string): Promise<void> {
        await this.sendRequest("DELETE", this.pathFor(key));
    }

    async testConnection(): Promise<void> {
        await this.sendRequest("HEAD", this.objectPath || "/");
    }

    keyFromUrl(value: string): string {
        try {
            const url = new URL(value);
            for (const base of this.urlBases) {
                const parsed = new URL(base);
                if (url.origin !== parsed.origin) continue;
                const basePath = decodeURIComponent(parsed.pathname).replace(/\/+$/, "");
                const path = decodeURIComponent(url.pathname);
                if (basePath && path !== basePath && !path.startsWith(`${basePath}/`)) continue;
                return path.slice(basePath.length).replace(/^\/+/, "");
            }
        } catch {
            return "";
        }
        return "";
    }

    private createKey(file: File): string {
        const extension = (
            file.name.match(/\.([a-z0-9]{1,10})$/i)?.[1] ||
            file.type.split("/")[1]?.split("+")[0] ||
            "bin"
        ).toLowerCase();
        const name = `${nextTimestamp()}.${extension}`;
        return this.prefix ? `${this.prefix}/${name}` : name;
    }

    private pathFor(key: string): string {
        return `${this.objectPath}/${encodeKey(key)}`;
    }

    private async urlForKey(key: string): Promise<string> {
        if (this.useSignedUrl) return this.presign(key);
        return `${this.publicBase || this.objectBase}/${encodeKey(key)}`;
    }

    private async sendRequest(method: string, path: string, body?: ArrayBuffer, contentType?: string): Promise<void> {
        const payloadHash = body ? await sha256(body) : EMPTY_SHA256;
        const date = amzDate();
        const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        const canonicalHeaders = `host:${this.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
        const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
        const scope = this.scopeFor(date);
        const signature = await this.signRequest(date, scope, canonicalRequest);

        const response = await requestUrl({
            url: `${this.origin}${path}`,
            method,
            body,
            headers: {
                Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
                "x-amz-content-sha256": payloadHash,
                "x-amz-date": date,
                ...(contentType ? { "Content-Type": contentType } : {}),
            },
            throw: false,
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(this.responseError(response.status, response.text));
        }
    }

    private async presign(key: string): Promise<string> {
        const date = amzDate();
        const scope = this.scopeFor(date);
        const path = this.pathFor(key);
        const query = [
            ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
            ["X-Amz-Credential", `${this.accessKeyId}/${scope}`],
            ["X-Amz-Date", date],
            ["X-Amz-Expires", "3600"],
            ["X-Amz-SignedHeaders", "host"],
        ].map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`).join("&");
        const canonicalRequest = `GET\n${path}\n${query}\nhost:${this.host}\n\nhost\nUNSIGNED-PAYLOAD`;
        const signature = await this.signRequest(date, scope, canonicalRequest);
        return `${this.origin}${path}?${query}&X-Amz-Signature=${signature}`;
    }

    private scopeFor(date: string): string {
        return `${date.slice(0, 8)}/${this.region}/s3/aws4_request`;
    }

    private async signRequest(date: string, scope: string, canonicalRequest: string): Promise<string> {
        const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await sha256(canonicalRequest)}`;
        return toHex(await hmac(await this.signingKey(date.slice(0, 8)), stringToSign));
    }

    private async signingKey(day: string): Promise<Uint8Array> {
        const dateKey = await hmac(textEncoder.encode(`AWS4${this.secretAccessKey}`), day);
        const regionKey = await hmac(dateKey, this.region);
        const serviceKey = await hmac(regionKey, "s3");
        return hmac(serviceKey, "aws4_request");
    }

    private normalizePublicBase(value: string): string {
        const trimmed = value.trim();
        if (!trimmed) return "";
        return (/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).replace(/\/+$/, "");
    }

    private responseError(status: number, body: string): string {
        const code = body.match(/<Code>([\s\S]*?)<\/Code>/)?.[1];
        const message = body.match(/<Message>([\s\S]*?)<\/Message>/)?.[1];
        const detail = [code, message].filter(Boolean).join(": ") || body.slice(0, 200).trim();
        return `S3 ${status}${detail ? `: ${detail}` : ""}`;
    }
}

class S3PicbedSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: S3PicbedPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.addText("Endpoint", "S3 API endpoint", "endpoint");
        this.addText("Bucket", "Bucket name", "bucket");
        this.addText("Region", "Required signing region", "region");
        this.addText("Access key ID", "S3 access key ID", "accessKeyId");
        this.addText("Secret access key", "S3 secret access key", "secretAccessKey", true);
        this.addText("Prefix", "Optional key prefix", "prefix");
        this.addText("Public URL", "Optional public domain", "publicUrl");

        new Setting(containerEl)
            .setName("Use signed URL")
            .setDesc("Private bucket; links expire in 1 hour")
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.useSignedUrl)
                .onChange(async value => {
                    this.plugin.settings.useSignedUrl = value;
                    await this.plugin.saveSettings();
                    this.plugin.initClient();
                }));

        new Setting(containerEl)
            .setName("Test connection")
            .setDesc("Test endpoint, bucket, region and credentials")
            .addButton(button => button
                .setButtonText("Test")
                .setCta()
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText("Testing...");
                    try {
                        await new S3Client(this.plugin.settings).testConnection();
                        new Notice("Connection successful");
                    } catch (error) {
                        new Notice(`Connection failed: ${errorText(error)}`);
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText("Test");
                    }
                }));
    }

    private addText(name: string, description: string, key: TextSettingKey, secret = false): void {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(description)
            .addText(text => {
                text.setValue(String(this.plugin.settings[key] ?? ""))
                    .onChange(async value => {
                        const trimmed = value.trim();
                        this.plugin.settings[key] = key === "prefix"
                            ? trimmed.replace(/^\/+|\/+$/g, "")
                            : trimmed;
                        await this.plugin.saveSettings();
                        this.plugin.initClient();
                    });
                text.inputEl.addClass("s3-picbed-input");
                if (secret) text.inputEl.type = "password";
            });
    }
}

export default class S3PicbedPlugin extends Plugin {
    settings!: S3PicbedSettings;
    private client: S3Client | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.initClient();
        this.registerEvent(this.app.workspace.on("editor-paste", (event, editor, view) => {
            if (event.defaultPrevented || !view.file) return;
            const files = this.getImageFiles(event);
            const client = this.client;
            if (!files.length || !client) return;
            event.preventDefault();
            this.uploadImages(client, files, editor).catch(error => new Notice(`Upload failed: ${errorText(error)}`));
        }));
        this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) =>
            this.onEditorMenu(menu, editor)));
        this.registerDomEvent(document, "contextmenu", (event: MouseEvent) =>
            this.onImageContextMenu(event), true);
        this.addSettingTab(new S3PicbedSettingTab(this.app, this));
    }

    onunload(): void {
        this.client = null;
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) as Partial<S3PicbedSettings> | null;
        this.settings = Object.assign({}, EMPTY_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    initClient(): void {
        try {
            this.client = new S3Client(this.settings);
        } catch {
            this.client = null;
        }
    }

    private getImageFiles(event: ClipboardEvent): File[] {
        const clipboard = event.clipboardData;
        const files: File[] = clipboard
            ? Array.from(clipboard.files).filter(isImageFile)
            : [];
        if (!files.length && clipboard) {
            for (const item of Array.from(clipboard.items)) {
                const file = item.kind === "file" ? item.getAsFile() : null;
                if (file && isImageFile(file)) files.push(file);
            }
        }
        return files;
    }

    private async uploadImages(client: S3Client, files: File[], editor: Editor): Promise<void> {
        const tokens = files.map((_, index) =>
            `{{S3_UPLOADING:${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}}}`);
        editor.replaceSelection(tokens.join(""));

        let failed = 0;
        await Promise.all(files.map(async (file, index) => {
            const token = tokens[index];
            try {
                const url = await client.upload(file);
                this.replaceToken(editor, token, `![](${url})`);
            } catch (error) {
                failed++;
                this.replaceToken(editor, token, "");
                new Notice(`Upload failed: ${errorText(error)}`);
            }
        }));

        if (!failed) new Notice(files.length === 1 ? "Image uploaded" : `${files.length} images uploaded`);
    }

    private replaceToken(editor: Editor, token: string, replacement: string): void {
        const content = editor.getValue();
        const index = content.indexOf(token);
        if (index < 0) return;

        const cursor = editor.posToOffset(editor.getCursor());
        editor.replaceRange(replacement, editor.offsetToPos(index), editor.offsetToPos(index + token.length));

        if (cursor >= index) {
            const next = cursor < index + token.length
                ? index + replacement.length
                : cursor - token.length + replacement.length;
            editor.setCursor(editor.offsetToPos(next));
        }
    }

    private onEditorMenu(menu: Menu, editor: Editor): void {
        const client = this.client;
        if (!client) return;

        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const images = imageMatches(line)
            .map(image => ({ image, key: client.keyFromUrl(urlFromMarkdown(image[1])) }))
            .filter(item => item.key);
        const target = images.find(item =>
            cursor.ch >= item.image.index && cursor.ch <= item.image.index + item.image[0].length) || images[0];

        if (target) {
            const index = editor.posToOffset({ line: cursor.line, ch: 0 }) + target.image.index;
            this.addDeleteImageMenuItem(menu, editor, target.key, target.image[0], index);
        }
        this.addDeleteAllMenuItem(menu, editor);
    }

    private onImageContextMenu(event: MouseEvent): void {
        const client = this.client;
        const target = event.target;
        if (!client || !(target instanceof Element)) return;

        const image = target.closest("img") ?? target.querySelector("img");
        if (!image) return;

        const src = image.currentSrc || image.src;
        const key = client.keyFromUrl(src);
        if (!key) return;

        const view = this.findMarkdownView(image);
        if (!view || view.getMode() !== "source") return;

        const editor = view.editor;
        const match = this.findImageLink(editor.getValue(), src, key, client);
        if (!match) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        const menu = new Menu();
        this.addDeleteImageMenuItem(menu, editor, key, match[0], match.index);
        this.addDeleteAllMenuItem(menu, editor);
        menu.showAtMouseEvent(event);
    }

    private addDeleteImageMenuItem(menu: Menu, editor: Editor, key: string, markdown: string, index: number): void {
        menu.addItem(item => item
            .setTitle("Delete this image")
            .setIcon("trash")
            .onClick(() => { void this.deleteImage(editor, key, markdown, index); }));
    }

    private addDeleteAllMenuItem(menu: Menu, editor: Editor): void {
        menu.addItem(item => item
            .setTitle("Delete all images in bucket")
            .setIcon("trash")
            .onClick(() => {
                this.deleteAllImages(editor).catch(error =>
                    new Notice(`Delete failed: ${errorText(error)}`));
            }));
    }

    private findMarkdownView(element: Element): MarkdownView | null {
        let result: MarkdownView | null = null;
        this.app.workspace.iterateAllLeaves(leaf => {
            if (!result && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(element)) {
                result = leaf.view;
            }
        });
        return result;
    }

    private findImageLink(content: string, src: string, key: string, client: S3Client): RegExpExecArray | null {
        const images = imageMatches(content);
        return images.find(image => urlFromMarkdown(image[1]) === src) ||
            images.find(image => client.keyFromUrl(urlFromMarkdown(image[1])) === key) ||
            null;
    }

    private async deleteImage(editor: Editor, key: string, markdown: string, index: number): Promise<void> {
        const client = this.client;
        if (!client) return;

        try {
            await client.delete(key);
            const content = editor.getValue();
            const from = content.slice(index, index + markdown.length) === markdown
                ? index
                : content.indexOf(markdown);
            if (from >= 0) {
                editor.replaceRange("", editor.offsetToPos(from), editor.offsetToPos(from + markdown.length));
            }
            new Notice("Image deleted");
        } catch (error) {
            new Notice(`Delete failed: ${errorText(error)}`);
        }
    }

    private async deleteAllImages(editor: Editor): Promise<void> {
        const client = this.client;
        if (!client) return;

        const keys = Array.from(new Set(
            imageMatches(editor.getValue())
                .map(match => client.keyFromUrl(urlFromMarkdown(match[1])))
                .filter(key => key)
        ));

        if (!keys.length) {
            new Notice("No images from this bucket found");
            return;
        }

        const deletedKeys = new Set<string>();
        await Promise.all(keys.map(async key => {
            try {
                await client.delete(key);
                deletedKeys.add(key);
            } catch (error) {
                console.error(`Delete failed for ${key}:`, error);
            }
        }));

        const current = editor.getValue();
        const matches = imageMatches(current)
            .filter(match => deletedKeys.has(client.keyFromUrl(urlFromMarkdown(match[1]))));
        let updated = current;
        for (const match of matches.slice().sort((a, b) => b.index - a.index)) {
            updated = updated.slice(0, match.index) + updated.slice(match.index + match[0].length);
        }
        if (matches.length) editor.setValue(updated);

        const deleted = matches.length;
        const failed = keys.length - deletedKeys.size;
        new Notice(`Deleted ${deleted} image${deleted === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`);
    }
}
