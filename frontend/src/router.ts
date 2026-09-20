import { createRouter, createWebHistory } from 'vue-router';
import MainChat from './views/MainChat.vue';
import Boards from './views/Boards.vue';

export default createRouter({
	history: createWebHistory(),
	routes: [
		{ path: '/', component: MainChat },
		{ path: '/boards', component: Boards },
		{ path: '/boards/:id', component: Boards },
	],
});
