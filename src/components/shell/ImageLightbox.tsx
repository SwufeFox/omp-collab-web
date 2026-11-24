import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

export interface ImageLightboxProps {
	src: string | null;
	alt?: string;
	onClose(): void;
}

export function ImageLightbox({ src, alt = "Image preview", onClose }: ImageLightboxProps): ReactNode {
	useEffect(() => {
		if (!src) return;
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [src, onClose]);

	if (!src) return null;

	return (
		<div
			className="sh-lightbox"
			role="dialog"
			aria-modal="true"
			aria-label={alt}
			onClick={onClose}
		>
			<button
				type="button"
				className="sh-lightbox-close"
				onClick={onClose}
				aria-label="Close image preview"
				title="Close (Esc)"
			>
				<X size={18} aria-hidden />
			</button>
			<img
				className="sh-lightbox-img"
				src={src}
				alt={alt}
				onClick={e => e.stopPropagation()}
			/>
		</div>
	);
}
