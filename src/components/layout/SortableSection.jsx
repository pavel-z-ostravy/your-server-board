import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BiMove } from "react-icons/bi";

// Wraps one whole dashboard section (a services/bookmarks block, Virtual
// Machines, Disks, ...) to make it draggable as a unit. The grip strip above
// the section is the only drag source - the section's own content (buttons,
// links, collapse toggles) stays fully interactive. Nothing is absolutely
// positioned over existing content, so this can't collide with a section's
// own header buttons the way an overlay handle could.
export default function SortableSection({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "opacity-50" : undefined}>
      <div className="flex justify-center">
        <button
          type="button"
          aria-label="Drag to reorder this section"
          className="touch-none cursor-grab rounded px-8 py-0.5 text-theme-400 hover:bg-theme-100/40 hover:text-theme-600 active:cursor-grabbing dark:text-theme-500 dark:hover:bg-white/5 dark:hover:text-theme-300"
          {...attributes}
          {...listeners}
        >
          <BiMove size={16} />
        </button>
      </div>
      {children}
    </div>
  );
}
