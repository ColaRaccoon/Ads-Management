import {createRelayHandler} from './relay.mjs';
// Platform secrets are project-wide. This function reads only these two dedicated names.
Deno.serve(createRelayHandler({env:{basicPassword:Deno.env.get('PHASE08_RELAY_BASIC_PASSWORD'),
 machineToken:Deno.env.get('PHASE08_RELAY_MACHINE_TOKEN')}}));
