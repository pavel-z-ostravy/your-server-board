import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { reorderSectionIds } from "utils/config/layoutOrder";

import SortableSection from "./SortableSection";

// `sections` is the ordered array of { id, element } to render - the caller
// (src/pages/index.jsx) owns the order and re-renders with a new array
// after a drop. This component only translates a dnd-kit drag gesture into
// that new order via onReorder(newOrderIds); it holds no order state itself.
export default function SortableSectionList({ sections, onReorder }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const currentOrder = sections.map((section) => section.id);
    const nextOrder = reorderSectionIds(currentOrder, active.id, over.id);
    if (nextOrder !== currentOrder) {
      onReorder(nextOrder);
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sections.map((section) => section.id)} strategy={verticalListSortingStrategy}>
        {sections.map(({ id, element }) => (
          <SortableSection key={id} id={id}>
            {element}
          </SortableSection>
        ))}
      </SortableContext>
    </DndContext>
  );
}
