import { createContext, useContext, type ReactNode } from "react";

export type SelectedDateContextValue = {
  monthId: string;
  selectedDay: number;
  selectedDateKey: string;
  setSelectedDay: (dayNo: number) => void;
};

const SelectedDateContext = createContext<SelectedDateContextValue | null>(null);

export function SelectedDateProvider({
  value,
  children
}: {
  value: SelectedDateContextValue;
  children: ReactNode;
}) {
  return (
    <SelectedDateContext.Provider value={value}>
      {children}
    </SelectedDateContext.Provider>
  );
}

export function useSelectedDate() {
  const context = useContext(SelectedDateContext);
  if (!context) {
    throw new Error("useSelectedDate must be used inside SelectedDateProvider.");
  }
  return context;
}
