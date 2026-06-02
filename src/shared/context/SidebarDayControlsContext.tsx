import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

type SidebarDayControlsState = {
  key: string;
  content: ReactNode;
} | null;

const SidebarDayControlsStateContext = createContext<SidebarDayControlsState>(null);
const SidebarDayControlsSetterContext = createContext<Dispatch<SetStateAction<SidebarDayControlsState>> | null>(null);

export function SidebarDayControlsProvider({ children }: { children: ReactNode }) {
  const [controls, setControls] = useState<SidebarDayControlsState>(null);
  return (
    <SidebarDayControlsSetterContext.Provider value={setControls}>
      <SidebarDayControlsStateContext.Provider value={controls}>
        {children}
      </SidebarDayControlsStateContext.Provider>
    </SidebarDayControlsSetterContext.Provider>
  );
}

export function SidebarDayControlsSlot() {
  const controls = useContext(SidebarDayControlsStateContext);
  return controls?.content ?? null;
}

export function useSidebarDayControls(key: string, content: ReactNode, active = true) {
  const setControls = useContext(SidebarDayControlsSetterContext);
  if (!setControls) {
    throw new Error("useSidebarDayControls must be used inside SidebarDayControlsProvider.");
  }

  useEffect(() => {
    if (!active) {
      setControls((current) => current?.key === key ? null : current);
      return undefined;
    }
    setControls((current) => (
      current?.key === key && current.content === content ? current : { key, content }
    ));
    return () => {
      setControls((current) => current?.key === key ? null : current);
    };
  }, [active, content, key, setControls]);
}
