"use client";

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from "react";
import { Send, LayoutTemplate, Paperclip, Mic, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReplyQuote } from "./reply-quote";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  bannerMessage?: string;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia?: (file: File, caption?: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
}

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fileEmoji(file: File) {
  if (file.type.startsWith("image/")) return "🖼";
  if (file.type.startsWith("video/")) return "🎬";
  if (file.type.startsWith("audio/")) return "🎵";
  return "📄";
}

export function MessageComposer({
  conversationId,
  sessionExpired,
  bannerMessage,
  onSend,
  onSendMedia,
  onOpenTemplates,
  replyTo,
  onClearReply,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks whether the current recording was cancelled so onstop can skip file creation
  const recordingCancelledRef = useRef(false);

  // Revoke preview blob URL and clear timer on unmount
  useEffect(() => {
    return () => {
      if (filePreview?.startsWith("blob:")) URL.revokeObjectURL(filePreview);
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearPendingFile = useCallback(() => {
    if (filePreview?.startsWith("blob:")) URL.revokeObjectURL(filePreview);
    setPendingFile(null);
    setFilePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [filePreview]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setPendingFile(file);
      if (file.type.startsWith("image/")) {
        setFilePreview(URL.createObjectURL(file));
      } else {
        setFilePreview(null);
      }
    },
    [],
  );

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    if (sending || sessionExpired) return;

    if (pendingFile && onSendMedia) {
      const file = pendingFile;
      const caption = text.trim() || undefined;
      clearPendingFile();
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      onSendMedia(file, caption);
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, pendingFile, onSendMedia, onSend, replyTo?.id, clearPendingFile]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const startRecording = useCallback(async () => {
    try {
      // Check current permission state first so we can give better
      // guidance if the user previously denied it.
      let blocked = false;
      try {
        const perm =
          await navigator.permissions.query({ name: "microphone" as PermissionName });
        blocked = perm.state === "denied";
        if (blocked) {
          toast.error(
            "Microphone is blocked for this site. Click the lock/tune icon in the address bar, find Microphone, and switch it to Allow — then try again.",
            { duration: 8000 },
          );
          return;
        }
      } catch {
        // permissions.query may not be supported (Safari < 16, Firefox < 70).
        // Fall through to getUserMedia which will trigger the browser prompt.
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
          ? "audio/ogg;codecs=opus"
          : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recordingCancelledRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingCancelledRef.current) {
          recordingCancelledRef.current = false;
          audioChunksRef.current = [];
          setIsRecording(false);
          setRecordingSeconds(0);
          return;
        }
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const ext = mimeType.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType });
        // Send the voice note immediately — no second click needed.
        if (onSendMedia) {
          onSendMedia(file);
        } else {
          setPendingFile(file);
          setFilePreview(null);
        }
        setIsRecording(false);
        setRecordingSeconds(0);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        toast.error(
          "Microphone access denied. Click the lock/tune icon in the address bar, find Microphone, and switch it to Allow — then try again.",
          { duration: 8000 },
        );
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        toast.error("No microphone found. Please connect a microphone and try again.");
      } else {
        const message = err instanceof Error ? err.message : "Could not start recording";
        toast.error(message);
      }
    }
  }, [onSendMedia]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancelRecording = useCallback(() => {
    recordingCancelledRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    setRecordingSeconds(0);
  }, []);

  const showSendButton = !!(text.trim() || pendingFile);
  const inputDisabled = sessionExpired;

  return (
    <div className="border-t border-slate-800 bg-slate-900 p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}

      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {bannerMessage ?? "24-hour session expired. Use a template to re-engage."}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            Templates
          </Button>
        </div>
      )}

      {/* File preview */}
      {pendingFile && !isRecording && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
          {filePreview ? (
            <img
              src={filePreview}
              alt="preview"
              className="h-12 w-12 rounded object-cover"
            />
          ) : (
            <span className="text-2xl leading-none">{fileEmoji(pendingFile)}</span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-slate-200">{pendingFile.name}</p>
            <p className="text-[10px] text-slate-500">
              {(pendingFile.size / 1024).toFixed(0)} KB
            </p>
          </div>
          <button
            type="button"
            onClick={clearPendingFile}
            className="shrink-0 rounded p-1 text-slate-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Recording UI */}
      {isRecording && (
        <div className="mb-2 flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
          <button
            type="button"
            onClick={cancelRecording}
            className="shrink-0 text-slate-400 hover:text-white"
            title="Cancel recording"
          >
            <X className="h-5 w-5" />
          </button>
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 font-mono text-sm text-slate-200">
            {formatSeconds(recordingSeconds)}
          </span>
          <Button
            size="sm"
            className="h-8 w-8 shrink-0 bg-primary p-0 hover:bg-primary/90"
            onClick={stopRecording}
            title="Stop and send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Main input row */}
      {!isRecording && (
        <div className="flex items-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-white"
            onClick={onOpenTemplates}
            title="Send template"
          >
            <LayoutTemplate className="h-4 w-4" />
          </Button>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/mp4,video/3gp,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-white"
            onClick={() => fileInputRef.current?.click()}
            disabled={inputDisabled}
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              sessionExpired
                ? "Use a template to send a message"
                : pendingFile
                  ? "Add a caption... (optional)"
                  : "Type a message... (Shift+Enter for new line)"
            }
            disabled={inputDisabled}
            rows={1}
            className={cn(
              "flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-primary/50",
              inputDisabled && "cursor-not-allowed opacity-50",
            )}
          />

          {showSendButton ? (
            <Button
              size="sm"
              className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
              disabled={sending}
              onClick={handleSend}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-red-400 disabled:opacity-40"
              disabled={inputDisabled || !onSendMedia}
              onClick={startRecording}
              title="Record voice message"
            >
              <Mic className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      <p className="mt-1 truncate pl-[72px] text-[10px] text-slate-600 sm:pl-[88px]">
        Type &apos;/&apos; for quick replies
      </p>
    </div>
  );
}
