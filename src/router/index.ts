import { createRouter, createWebHashHistory } from "vue-router";
import ScheduleView from "../views/ScheduleView.vue";
import ConflictView from "../views/ConflictView.vue";
import HistoryView from "../views/HistoryView.vue";
import RescheduleView from "../views/RescheduleView.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "schedule", component: ScheduleView },
    { path: "/reschedule", name: "reschedule", component: RescheduleView },
    { path: "/conflicts", name: "conflicts", component: ConflictView },
    { path: "/history", name: "history", component: HistoryView }
  ]
});
