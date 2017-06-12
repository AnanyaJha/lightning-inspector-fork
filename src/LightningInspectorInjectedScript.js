import ComponentTree from "./aura/ComponentTree.js";
import Serializer from "./aura/Serializer.js";
import UnStrictApis from "./aura/gatherer/unStrictApis.js";

//*** Used by Aura Inspector
// This is injected in the DOM directly via <script> injection
    const $Aura = {};

    // Do NOT use this pattern, it's tech-debt and should be removed. Add all logic to AuraInspector.
    $Aura.actions = {
        "AuraDevToolService.HighlightElement": function(globalId) {
            // Ensure the classes are present that HighlightElement depends on.
            if(!$Aura.actions["AuraDevToolService.AddStyleRules"].addedStyleRules) {
                $Aura.actions["AuraDevToolService.AddStyleRules"](globalId);
                $Aura.actions["AuraDevToolService.AddStyleRules"].addedStyleRules = true;
            }

            var className = "auraDevToolServiceHighlight3";
            var previous = document.getElementsByClassName(className);
            for(var d=previous.length-1,current;d>=0;d--){
                current = previous[d];
                current.classList.remove(className);
                current.classList.remove("auraDevToolServiceHighlight4");
            }

            // Apply the classes to the elements
            if(globalId) {
                var cmp = $A.getCmp(globalId);
                if(cmp && cmp.isValid()) {
                    var elements = cmp.getElements();
                    // todo: add classes to elements
                    for(var c=0,length=elements.length;c<length;c++) {
                        if(elements[c].nodeType === 1){
                            elements[c].classList.add(className);
                        }
                    }
                }
            }
        },

        "AuraDevToolService.RemoveHighlightElement": function() {
            var removeClassName = "auraDevToolServiceHighlight3";
            var addClassName = "auraDevToolServiceHighlight4";
            var previous = document.getElementsByClassName(removeClassName);
            for(var d=previous.length-1;d>=0;d--){
                previous[d].classList.add(addClassName);
                //previous[d].classList.remove(removeClassName);
            }

        },

        "AuraDevToolService.AddStyleRules": function(globalId) {
            var styleRuleId = "AuraDevToolService.AddStyleRules";

            // Already added
            if(document.getElementById(styleRuleId)) { return; }

            var rules = `
                .auraDevToolServiceHighlight3:before{
                   position:absolute;
                   display:block;
                   width:100%;
                   height:100%;
                   z-index: 10000;
                   background-color:#006699;
                   opacity:.3;
                   content:' ';
                   border : 2px dashed white;
                }
                .auraDevToolServiceHighlight4.auraDevToolServiceHighlight3:before {
                   opacity: 0;
                   transition: opacity 2s;
                }
            `;

            var style = document.createElement("style");
                style.id = styleRuleId;
                style.textContent = rules;
                style.innerText = rules;

            var head = document.head;
                head.appendChild(style);


            document.body.addEventListener("transitionend", function removeClassHandler(event) {
                var removeClassName = "auraDevToolServiceHighlight3";
                var addClassName = "auraDevToolServiceHighlight4";
                var element = event.target;
                element.classList.remove(removeClassName);
                element.classList.remove(addClassName);
            });
        }
    };

    var $Symbol = Symbol.for("AuraDevTools");

    // Communicate directly with the aura inspector
    $Aura.Inspector = new AuraInspector();
    $Aura.Inspector.init();

    // Attach to the global object so our integrations can access it, but
    // use a symbol so it doesn't create a global property.
    window[$Symbol] = $Aura;

    function AuraInspector() {
        var subscribers = {};
        var PUBLISH_KEY = "AuraInspector:publish";
        var PUBLISH_BATCH_KEY = "AuraInspector:publishbatch";
        var BOOTSTRAP_KEY = "AuraInspector:bootstrap";
        var postMessagesQueue = [];
        var batchPostId = null;
        var lastItemInspected;
        var countMap = {};
        var instrumented = {
            "actions": false,
            "all": false
        };

        // For dropping actions
        var actionsWatched = {};
        var actionsToWatch = {};

        this.init = function() {
            // Add Rightclick handler. Just track what we rightclicked on.
            addRightClickObserver();

            this.subscribe("AuraInspector:ContextElementRequest", () => {
                if(lastItemInspected && lastItemInspected.nodeType === 1) {
                    this.publish("AuraInspector:ShowComponentInTree", lastItemInspected.getAttribute("data-aura-rendered-by"));
                }
            });

            // Aura's present, our script is present, bootstrap!
            this.subscribe("AuraInspector:OnAuraInitialized", () => {
                this.instrument();
                this.subscribe("AuraInspector:OnPanelConnect", AuraInspector_OnPanelLoad.bind(this));
            });

            // Component tree hovering to show the element in the dom.
            this.subscribe("AuraInspector:OnHighlightComponent", $Aura.actions["AuraDevToolService.HighlightElement"]);
            this.subscribe("AuraInspector:OnHighlightComponentEnd", $Aura.actions["AuraDevToolService.RemoveHighlightElement"]);

            // Action dropping and modifying
            this.subscribe("AuraInspector:OnActionToWatchEnqueue", AuraInspector_OnActionToWatchEnqueue.bind(this));
            this.subscribe("AuraInspector:OnActionToRemoveFromWatchEnqueue", AuraInspector_RemoveActionFromWatch.bind(this));
            this.subscribe("AuraInspector:OnActionToWatchClear", AuraInspector_RemoveActionsFromWatch.bind(this));

            // Aura is present and the root has already been initialized.
            if(window.$A && window.$A.getContext && !!window.$A.getContext()) {
                this.instrument();
                this.publish("AuraInspector:OnAuraInitialized", "InjectedScript: Aura Present already during load." );
            }

            if(document.readyState === "complete") {
                if(!window.$A) {
                    this.publish("AuraInspector:OnAuraUnavailable", {});
                }
            } else {
                window.addEventListener("load", () => {
                    if(!window.$A) {
                        this.publish("AuraInspector:OnAuraUnavailable", {});
                    }
                });
            }

            this.publish("AuraInspector:OnInjectionScriptInitialized")
        };

        this.instrument = function() {
            if(instrumented.all) {
                // If you close the panel, then reopen it, the bootstrap will have already happened
                // on the page. But the inspector doesn't know that, we still need to communicate
                // to it that we're done. So we always post the bootstrap back.
                window.postMessage({
                    "action": "AuraInspector:bootstrap",
                    "key": "AuraInspector:bootstrap",
                    "data": "InjectedScript: Aura is already present at initialization, calling bootstrap."
                }, window.location.origin);
                return;
            }

            if (typeof $A === "undefined" || !($A.getContext && $A.getContext())) {
                // Aura isn't ready yet.
                return;
            }

            // Try catches for branches that don't have the overrides
            // This instrument is where we add the methods _$getRawValue$() and _$getSelfGlobalId$() to the
            // component prototype. This allowed us to move to outputing the component from injected code, vs code in the framework.
            // Would be nice to get rid of needing this.
            try {
                $A.installOverride("outputComponent", function(){});
            } catch(e){}

            try {
                // Counts how many times various things have happened.
                bootstrapCounters();
            } catch(e){}

            try {
                // Actions Tab
                this.instrumentActions();
             } catch(e){
             }
             try {
                // Perf Tab
                bootstrapPerfDevTools();
             } catch(e){

             }
             try {
                // Events Tab
                bootstrapEventInstrumentation();
            } catch(e){}

            try {
                bootstrapTransactionReporting();
            } catch(e){}

            // Need a way to conditionally do this based on a user setting.
            $A.PerfDevTools.init();

            window.postMessage({
                "action": "AuraInspector:bootstrap",
                "key":"AuraInspector:bootstrap",
                "data": "InjectedScript: $Aura.Inspector.instrument()"
            }, window.location.origin);

            instrumented.all = true;
        };

        // Just incase for legacy, remove say 210
        this.bootstrap = this.instrument;

        this.instrumentActions = function() {
            if(instrumented.actions) {
                return;
            }

            $A.installOverride("enqueueAction", OnEnqueueAction);
            //$A.installOverride("Action.finishAction", OnFinishAction);
            $A.installOverride("Action.abort", OnAbortAction);
            $A.installOverride("Action.runDeprecated", OnActionRunDeprecated);
            $A.installOverride("Action.finishAction", Action_OnFinishAction.bind(this));
            $A.installOverride("ClientService.send", ClientService_OnSend.bind(this));
            $A.installOverride("ClientService.decode", ClientService_OnDecode.bind(this));

            instrumented.actions = true;

            //oldResponse: XMLHttpRequest
            //actionsFromAuraXHR: AuraXHR keep an object called actions, it has all actions client side are waiting for response, a map between actionId and action.
            function ClientService_OnDecode(config, oldResponse, noStrip) {
                //var response = oldResponse["response"];
                if(!oldResponse["response"] || oldResponse["response"].length == 0) {
                    console.warn("AuraInspectorInjectedScript.onDecode received a bad response.", oldResponse);
                    return config["fn"].call(config["scope"], oldResponse, noStrip);
                }

                //modify response if we find the action we are watching
                var response = oldResponse["response"];
                var oldResponseText = oldResponse["responseText"];
                var newResponseText = oldResponseText;
                // var responseModified = false;//if we modify the response, set this to true
                // var responseWithError = false;//if we send back error response, set this to true
                // var responseWithIncomplete = false;//if we want to kill the action, set this to true

                if(this.hasWatchedActions()) {
                    try {
                        for(var actionId in actionsWatched) {
                            if(!oldResponseText.includes(actionId) || !oldResponseText.startsWith("while(1);")) {
                                continue;
                            }

                            var actionWatched = actionsWatched[actionId];
                            var actionsObj = getActionsFromResponseText(oldResponseText);
                            var responseActions = actionsObj && actionsObj.actions || [];
                            
                            var actionFound;
                            var restOfActions = responseActions.filter((current) => {
                                if(current.id === actionId) {
                                    actionFound = current; 
                                    return false;
                                } else {
                                    return true;
                                }
                            });
                            
                            // We have not yet found an action in the existing set we want to modify
                            if(!actionFound) {
                                continue;
                            }
                            //we would like to return error response
                            if(actionWatched.nextError) {
                                actionFound.state = "ERROR";
                                actionFound.error = [actionWatched.nextError];
                                actionFound.returnValue = null;
                                var actionsEndIndex = oldResponseText.indexOf("context\"");
                                newResponseText = "while(1);\n{\"actions\":"+JSON.stringify(restOfActions.concat(actionFound))+",\""+oldResponseText.substring(actionsEndIndex,oldResponseText.length);
                                //move the actionCard from watch list to Processed
                                //this will call AuraInspectorActionsView_OnActionStateChange in AuraInspectorActionsView.js
                                $Aura.Inspector.publish("AuraInspector:OnActionStateChange", {
                                        "id": actionId,
                                        "idtoWatch": actionWatched.idtoWatch,
                                        "state": "RESPONSEMODIFIED",
                                        "sentTime": performance.now()//do we need this?
                                });

                                const newHttpRequest = {
                                    "status": 200,
                                    "response": newResponseText,
                                    "responseText": newResponseText,
                                    "$hasError": true
                                };
                                
                                return config["fn"].call(config["scope"], newHttpRequest, noStrip);
                            } 
                            //we would like to return non-error response
                            else if(actionWatched.nextResponse) {
                                var responseModified = Object.assign(actionFound.returnValue, actionWatched.nextResponse);
                                if(responseModified) {
                                    actionFound.returnValue = responseModified;
                                    var actionsEndIndex = oldResponseText.indexOf("context\"");
                                    newResponseText = "while(1);\n{\"actions\":"+JSON.stringify(restOfActions.concat(actionFound))+",\""+oldResponseText.substring(actionsEndIndex,oldResponseText.length);

                                    //move the actionCard from watch list to Processed
                                    //this will call AuraInspectorActionsView_OnActionStateChange in AuraInspectorActionsView.js
                                    $Aura.Inspector.publish("AuraInspector:OnActionStateChange", {
                                            "id": actionId,
                                            "idtoWatch": actionWatched.idtoWatch,
                                            "state": "RESPONSEMODIFIED",
                                            "sentTime": performance.now()//do we need this?
                                    });
                                    
                                    const newHttpRequest = Object.assign($A.util.apply({}, oldResponse), {
                                        "response": newResponseText,
                                        "responseText": newResponseText,
                                        "$isModified": true
                                    });

                                    return config["fn"].call(config["scope"], newHttpRequest, noStrip);
                                }
                            } 
                            //we would like to kill action, return incomplete
                            else {
                                //responseWithIncomplete = true;
                                //move the actionCard from watch list to Processed
                                //this will call AuraInspectorActionsView_OnActionStateChange in AuraInspectorActionsView.js
                                $Aura.Inspector.publish("AuraInspector:OnActionStateChange", {
                                        "id": actionId,
                                        "idtoWatch": actionWatched.idtoWatch,
                                        "state": "RESPONSEMODIFIED",
                                        "sentTime": performance.now(),//do we need this?
                                        "byChaosRun": actionWatched.byChaosRun
                                });
                                if(actionWatched.byChaosRun) {
                                    $Aura.Inspector.publish("AuraInspector:OnCreateChaosCard", {"message": "Drop action "+actionWatched.id + ", the old actionId from replay: "+actionWatched.idtoWatch} );
                                    if(actionWatched.id === actionWatched.idtoWatch) {
                                        console.warn("The action in your replay has the same id as the action being dropped, this will confuse ActionTab, as it use actionId to find and move actionCard around. Please change action id in your replay file to something else, like 9999 :-) ");
                                    }
                                }

                                const newHttpRequest = {
                                    "status": 0,
                                    "$isIncomplete": true
                                };
                                
                                return config["fn"].call(config["scope"], newHttpRequest, noStrip);
                            }
                        
                        }
                    } catch(e) {
                        console.warn("get response we cannot parse with JSON.parse, skip", oldResponse, e);
                        return config["fn"].call(config["scope"], oldResponse, noStrip);
                    }
                }

                /** CHAOS **/
                // if($Sfdc.chaos.shouldWeDropAction()) {
                //     //if we are in a new chaos run and user would like to drop action randomly
                //     responseWithIncomplete = $Sfdc.chaos.randomlyDropAction(responseWithIncomplete, oldResponseText); 
                // }

                // if($Sfdc.chaos.shouldWeErrorResponseAction()) {
                //     //if we are in a new chaos run and we would like to return error response randomly
                //     const resObj = $Sfdc.chaos.randomlyReturnErrorResponseForAction(responseWithIncomplete, oldResponseText);
                //     responseWithError = resObj.responseWithError;
                //     newResponseText = resObj.newResponseText;
                // }
                /** End Chaos **/
                
                // if(responseWithIncomplete) {
                //     const newHttpRequest = {
                //         "status": 0,
                //         "$isIncomplete": true
                //     };
                    
                //     return config["fn"].call(config["scope"], newHttpRequest, noStrip);
                // }
                // else if(responseModified === true) {
                //     const newHttpRequest = Object.assign({}, oldResponse, {
                //         "response": newResponseText,
                //         "responseText": newResponseText,
                //         "$isModified": true
                //     });
                //     newHttpRequest["response"] = newResponseText;
                //     newHttpRequest["responseText"] = newResponseText;

                //     return config["fn"].call(config["scope"], newHttpRequest, noStrip);
                // } else if (responseWithError === true) {
                //     const newHttpRequest = {
                //         "status": 500, // As long as it's not 200
                //         "response": newResponseText,
                //         "responseText": newResponseText,
                //         "$hasError": true
                //     };
                    
                //     return config["fn"].call(config["scope"], newHttpRequest, noStrip);
                // } else {
                //     //nothing happended, just send back oldResponse
                //     return config["fn"].call(config["scope"], oldResponse, noStrip);
                // }

                //nothing happended, just send back oldResponse
                return config["fn"].call(config["scope"], oldResponse, noStrip);
            }

            function addMessageAndStackToResponse(response, message, stack) {
                var actionsStartIdx = response.indexOf("actions");
                if(actionsStartIdx>0) {
                    return response.substring(0, actionsStartIdx-1)+"\"message\":\""+message+"\",\"stack\":\""+stack+"\"," + response.substring(actionsStartIdx-1, response.length);
                } else {
                    return response;
                }
            }

            function getActionsFromResponseText(response) {
                var actionsStartIdx = response.indexOf("actions");
                var actionsEndIndex = response.indexOf("\"context\":");
                if(actionsStartIdx>=0 && actionsEndIndex >=0 ) {
                    var actionsStrInResponse = response.substring(actionsStartIdx, actionsEndIndex).replace(/\s/g, "");//we don't want '"' right before the 'context'
                    if(actionsStrInResponse.lastIndexOf(",") == actionsStrInResponse.length -1) {//get rid of ','
                        actionsStrInResponse = actionsStrInResponse.substring(0, actionsStrInResponse.length-1);
                    } 
                    return JSON.parse("{\""+actionsStrInResponse+"}");
                }
            }
        }

        this.getWatchedAction = function(id) {
            return actionsWatched[id];
        };

        this.isWatchingForAction = function(reference) {
            if(typeof reference === "string") {
                return actionsToWatch[reference];
            }
            var name = reference.actionName;
            if($A.util.isAction(reference)) {
                name = reference.getDef().toString();
            }

            for(var actionName in actionsToWatch) {
                if(actionName.includes(name)) {
                    return actionsToWatch[actionName];
                }
            }
            return null;
        };

        this.hasWatchedActions = function() {
            return Object.getOwnPropertyNames(actionsWatched).length > 0;
        };

        this.isWatchingForActions = function() {
            return Object.getOwnPropertyNames(actionsToWatch).length > 0;
        };

        this.setWatchedActionAsProcessed = function(actionId) {
            delete actionsWatched[actionId];

            // what about actionsToWatch?
        };

        this.setWatchAsProcessed = function(actionName) {
            delete actionsToWatch[actionName];
        };

        this.setWatchedAction = function(action) {
            actionsWatched[action.getId()] = action;
        };

        //this.setWatchedAction = function() {};
        this.watchAction = function(action){
            actionsToWatch[action.actionName] = action;
        };

        this.cancelWatchOfAction  = function(actionName) {
            if(!actionName) { return; }

            if(actionsToWatch.hasOwnProperty(actionName)) {
                delete actionsToWatch[actionName];
            }
        };

        this.cancelWatchOfAllActions = function() {
            actionsToWatch = {};
        };

        this.publish = function(key, data) {
            if(!key) { return; }

            // We batch the post messages
            // to avoid excessive messages which was causing
            // stabalization issues.
            postMessagesQueue.push({"key":key, "data":data});

            if(batchPostId === null || batchPostId === undefined) {
                batchPostId = sendQueuedPostMessages();
            }
        };

        this.subscribe = function(key, callback) {
            if(!key || !callback) { return; }

            if(!subscribers[key]) {
                subscribers[key] = [];
            }

            subscribers[key].push(callback);
        };

        this.unsubscribe = function(key, callback) {
            if(!key || !callback) { return false; }

            if(!subscribers[key]) {
                return false;
            }

            var listeners = subscribers[key];
            subscribers[key] = listeners.filter(function(item){
                return item !== callback;
            });
        };

        // Overriden by some tricky code down below to try to get into the context of the app.
        this.accessTrap = function(callback) {
            if(typeof callback === "function") {
                callback();
            }
        };

        /**
         * Get all the top level elements.
         * This obviously includes $A.getRoot(), but for Lightning Out that is empty.
         * So we also include all the Disconnected components attached to dom elements.
         */
        this.getRootComponents = function() {
            return ComponentTree.getRootComponents();
        };

        this.getComponent = function(componentId, options) {
            return ComponentTree.getComponent(componentId, options);
        };

        /**
         * Increment a counter for the specified key.
         * @example
         * $Aura.Inspector.count('rendered');
         * $Aura.Inspector.count('rendered');
         * $Aura.Inspector.getCount('rendered'); // 2
         * @param  {String} key Any unique ID to count
         */
        this.count = function(key) {
            countMap[key] = countMap.hasOwnProperty(key) ? countMap[key] + 1 : 1;
        };

        /**
         * Get how many times a key has been counted without incrementing the counter.
         *
         * @param  {String} key Unique id to count.
         */
        this.getCount = function(key) {
            return countMap.hasOwnProperty(key) ? countMap[key] : 0;
        };

        /**
         * Reset a counted key to 0.
         *
         * @param  {String} key Unique id that you passed to this.count(key) to increment the counter.
         */
        this.clearCount = function(key) {
            if(countMap.hasOwnProperty(key)) {
                delete countMap[key];
            }
        };

        // Start listening for messages
        window.addEventListener("message", Handle_OnPostMessage);

        function Handle_OnPostMessage(event) {
            if(event && event.data) {
                if(event.data.action === PUBLISH_KEY) {
                    callSubscribers(event.data.key, event.data.data);
                } else if(event.data.action === PUBLISH_BATCH_KEY) {
                    var data = event.data.data || [];
                    for (var c = 0, length = data.length; c < length; c++) {
                        callSubscribers(data[c].key, data[c].data);
                    }
                }
            }
        }

        function AuraInspector_OnPanelLoad() {
            if(window.$A) {
                window.postMessage({
                    "action": "AuraInspector:bootstrap",
                    "key":"AuraInspector:bootstrap",
                    "data": "Panel connected, the injected script has already bootstrapped."
                }, window.location.origin);
            }
        }

        // This is temporary till we can add the data-ltngout-rendered-by attribute.
        function getComponentForLtngOut(components) {
            if(!components.length) { return; }
            let owner = components[0].getOwner();
            while(!owner.getOwner().isInstanceOf("aura:application") && owner.getOwner() !== owner) {
                owner = owner.getOwner();
            }
            return owner;
        }

        function callSubscribers(key, data) {
            if(subscribers[key]) {
                subscribers[key].forEach(function(callback){
                    callback(data);
                });
            }
        }

        function sendQueuedPostMessages() {
            if("requestIdleCallback" in window) {
                batchPostId = window.requestIdleCallback(sendQueuedPostMessagesCallback);
            } else {
                batchPostId = window.requestAnimationFrame(sendQueuedPostMessagesCallback);
            }

            function sendQueuedPostMessagesCallback() {
                if(postMessagesQueue.length) {
                    try {
                        window.postMessage({
                            "action": PUBLISH_BATCH_KEY,
                            "data": postMessagesQueue
                        }, window.location.origin);
                    } catch(e) {
                        console.error("AuraInspector: Failed to communicate to inspector.", e);
                    }
                }
                postMessagesQueue = [];
                batchPostId = null;
            }
        }

        function addRightClickObserver(){
            document.addEventListener("mousedown", function(event){
                // Right Click
                if(event.button === 2) {
                    var current = event.target;
                    while(current && current != document && !current.hasAttribute("data-aura-rendered-by")) {
                        current = current.parentNode;
                    }
                    lastItemInspected = current;
                }
            });
        }

    }

    function wrapFunction(target, methodName, newFunction) {
        if(typeof target[methodName] != "function") {
            return;
        }
        var original = target[methodName];
        target[methodName] = function() {
            newFunction.apply(this, arguments);
            return original.apply(this, arguments);
        };
    }

    function Action_OnFinishAction(config, context) {
        var startCounts = {
            "created": $Aura.Inspector.getCount("component_created")
        };

        var ret = config["fn"].call(config["scope"], context);

        var action = config["self"];

        var data = {
            "id": action.getId(),
            "state": action.getState(),
            "fromStorage": action.isFromStorage(),
            "returnValue": Serializer.stringify(action.getReturnValue()),
            "error": Serializer.stringify(action.getError()),
            "finishTime": performance.now(),
            "stats": {
                "created": $Aura.Inspector.getCount("component_created") - startCounts.created
            }
        };

        var actionWatched = this.getWatchedAction(action.getId());
        if(actionWatched) {
            if(actionWatched.nextError != undefined) {
                data.howDidWeModifyResponse = "responseModified_error";
            } else if (actionWatched.nextResponse != undefined) {
                data.howDidWeModifyResponse = "responseModified_modify";
            } else {
                data.howDidWeModifyResponse = "responseModified_drop";
            }

            this.setWatchedActionAsProcessed(action.getId());
        }

        this.publish("AuraInspector:OnActionStateChange", data);

        return ret;
    }

    function AuraInspector_OnActionToWatchEnqueue(data) {
        if(!data) {
            console.error("AuraDevToolService.AddActionToWatch receive no data from publisher");
        }
        //check if we already has the action in actionsToWatch, if so replace it with the new one
        var alreadyAdded = this.isWatchingForAction(data);

        if(alreadyAdded) {
            this.cancelWatchOfAction(data.actionName);
        } else {
            //remove the stored response from action storage -- if there is any
            if(data.actionIsStorable && data.actionIsStorable === true) {
                var actionsStorage = $A.storageService.getStorage("actions");
                var actionStorageKey = data.actionStorageKey;//data.actionName+JSON.stringify(data.actionParameter);//
                if(actionsStorage && actionStorageKey && actionStorageKey.length) {
                    actionsStorage.get(actionStorageKey)
                    .then(
                        function() {
                            //console.log("find storage item for action:", data);
                            actionsStorage.remove(actionStorageKey)
                            .then(function () {
                                $Aura.Inspector.publish("AuraInspector:RemoveStorageData", {'storageKey': actionStorageKey});
                            });
                        },
                        function(e) {
                            console.warn("cannot find storage item for action:", data);
                        }
                    );
                }
            }
        }

        this.watchAction(data);

        //ask chaos view to create a chaos card
        /** MOVE:Chaos */
        if(data.byChaosRun) {
            var actionName = data.actionName;
            if (actionName.indexOf("ACTION$") >= 0) {//action could be long, make it more readable
                actionName = actionName.substr(actionName.indexOf("ACTION$") + 7, actionName.length - 1);
            }
            $Aura.Inspector.publish("AuraInspector:OnCreateChaosCard", {"message": "add action "+actionName+" to watch list"} );
        }
    }

    function AuraInspector_RemoveActionFromWatch(data) {
        if(!data) {
            console.error("AuraDevToolService.RemoveActionFromWatch receive no data from publisher");
        }

        this.cancelWatchOfAction(data.actionName);
    }

    /*
    handler for AuraInspector:OnActionToWatchClear, this will clear up all actions from watch list
    */
    function AuraInspector_RemoveActionsFromWatch() {
        this.cancelWatchOfAllActions();
    }

    /**
     * Go through actionToWatch, if we run into an action we are watching, either drop it
     * or register with actionsWatched, so we can modify response later in onDecode 
     */
    function ClientService_OnSend(config, auraXHR, actions, method, options) {
        if (actions) {
            for(var c=0;c<actions.length;c++) {
                if(this.isWatchingForActions()) {
                    var action = actions[c];
                    var actionToWatch = this.isWatchingForAction(action);
                    if(actionToWatch) {
                        //udpate the record of what we are watching, this is mainly for action we want to modify response
                        if(this.getWatchedAction(action.getId())) {
                            console.warn("Error: we already watching this action:", action);
                        } else {
                            //copy nextResponse to actionWatched
                            action['nextError'] = actionToWatch.nextError;
                            action['nextResponse'] = actionToWatch.nextResponse;
                            action['idtoWatch'] = actionToWatch.actionId;
                            if(actionToWatch.byChaosRun) {
                                action['byChaosRun'] = actionToWatch.byChaosRun;
                            }

                            this.setWatchedAction(action);
                        }

                        this.setWatchAsProcessed(actionToWatch.actionName);
                    }
                }


                $Aura.Inspector.publish("AuraInspector:OnActionStateChange", {
                    "id": actions[c].getId(),
                    "state": "RUNNING",
                    "sentTime": performance.now()
                });
            }
        }

        var ret = config["fn"].call(config["scope"], auraXHR, actions, method, options);

        return ret;
    }

    function OnEnqueueAction(config, action, scope) {
        var ret = config["fn"].call(config["scope"], action, scope);

        var cmp = action.getComponent();
        var data =  {
            "id"         : action.getId(),
            "params"     : Serializer.stringify(action.getParams()),
            "abortable"  : action.isAbortable(),
            "storable"   : action.isStorable(),
            "background" : action.isBackground(),
            "state"      : action.getState(),
            "isRefresh"  : action.isRefreshAction(),
            "defName"    : action.getDef()+"",
            "fromStorage": action.isFromStorage(),
            "enqueueTime": performance.now(),
            "storageKey" : action.getStorageKey(),
            "callingCmp" : cmp && cmp.getGlobalId()
        };

        $Aura.Inspector.publish("AuraInspector:OnActionEnqueue", data);

        return ret;
    }

    // function OnFinishAction(config, context) {
    //     var startCounts = {
    //         "created": $Aura.Inspector.getCount("component_created")
    //     };

    //     var ret = config["fn"].call(config["scope"], context);

    //     var action = config["self"];

    //     var data = {
    //         "id": action.getId(),
    //         "state": action.getState(),
    //         "fromStorage": action.isFromStorage(),
    //         "returnValue": Serializer.stringify(action.getReturnValue()),
    //         "error": Serializer.stringify(action.getError()),
    //         "finishTime": performance.now(),
    //         "stats": {
    //             "created": $Aura.Inspector.getCount("component_created") - startCounts.created
    //         }
    //     };

    //     $Aura.Inspector.publish("AuraInspector:OnActionStateChange", data);

    //     return ret;
    // }

    function OnAbortAction(config, context) {
        var ret = config["fn"].call(config["scope"], context);

        var action = config["self"];

        var data = {
            "id": action.getId(),
            "state": action.getState(),
            "finishTime": performance.now()
        };

        $Aura.Inspector.publish("AuraInspector:OnActionStateChange", data);

        return ret;
    }

    function OnActionRunDeprecated(config, event) {
        var action = config["self"];
        var startTime = performance.now();
        var data = {
            "actionId": action.getId()
        };

        $Aura.Inspector.publish("AuraInspector:OnClientActionStart", data);

        var ret = config["fn"].call(config["scope"], event);

        data = {
            "actionId": action.getId(),
            "name": action.getDef().getName(),
            "scope": action.getComponent().getGlobalId()
        };

        $Aura.Inspector.publish("AuraInspector:OnClientActionEnd", data);
    }

    function bootstrapCounters() {
        // Count how many components are being created.
        $A.installOverride("ComponentService.createComponentPriv", function(){
             var config = Array.prototype.shift.apply(arguments);

             var ret = config["fn"].apply(config["scope"], arguments);

             $Aura.Inspector.count("component_created");

             return ret;
        });

        // No way of displaying this at the moment.
        // wrapFunction($A.Component.prototype, "render", function(){
        //     $Aura.Inspector.count("component_rendered");
        //     $Aura.Inspector.count(this.getGlobalId() + "_rendered");
        // });

        wrapFunction($A.Component.prototype, "rerender", function(){
            $Aura.Inspector.count("component_rerendered");
            $Aura.Inspector.count(this.getGlobalId() + "_rerendered");
        });

        /*
            I'll admit, this is a  hack into the Aura access check framework.
            I shouldn't rely on this, it's merely a best case scenario work around.
            Fallbacks should be present if I use this method.
         */
        var originalRender = $A.Component.prototype.render;
        wrapFunction($A.Component.prototype, "render", function(){
            var current = this.getDef();
            while(current.getSuperDef()) {
                current = current.getSuperDef();
            }
            if(current.getDescriptor().getQualifiedName() === "markup://aura:application") {
                $Aura.Inspector.accessTrap = $A.getCallback(function(callback) {
                    if(typeof callback === "function") {
                        callback();
                    }
                });
                // No need anymore to do the override. It's simply to attach this access trap.
                $A.Component.prototype.render = originalRender;
            }
        });
        // No way of displaying this at the moment.
        // wrapFunction($A.Component.prototype, "unrender", function(){
        //     $Aura.Inspector.count("component_unrendered");
        //     $Aura.Inspector.count(this.getGlobalId() + "_unrendered");
        // });
    }

    function bootstrapEventInstrumentation() {

        $A.installOverride("Event.fire", UnStrictApis.OnEventFire.bind($Aura, output));

        function output(data) {
            var componentToJSON = $A.Component.prototype.toJSON;
            delete $A.Component.prototype.toJSON;

            var json = Serializer.stringify(data, function(key, value){
                if($A.util.isComponent(value)) {
                    return "[Component] {" + value.getGlobalId() + "}";
                } else if(value instanceof Function) {
                    return value +"";
                }
                return value;
            });

            $A.Component.prototype.toJSON = componentToJSON;

            return json;
        }
    }

    function bootstrapTransactionReporting() {
        $A.metricsService.enablePlugins();

        $A.metricsService.transactionStart("AuraInspector", "transactionstab");

        $A.metricsService.onTransactionEnd(function(transaction){
            setTimeout(() => {
                $Aura.Inspector.publish("AuraInspector:OnTransactionEnd", transaction);
            }, 0);
        });

        $A.metricsService.onTransactionsKilled(function(transactions){
            if(transactions) {
                for(var c=0;c<transactions.length;c++) {
                    if(transactions[c].id === "AuraInspector:transactionstab") {
                        $A.metricsService.transactionStart("AuraInspector", "transactionstab");
                    }
                }
            }
        });
    }


    function bootstrapPerfDevTools() {
        $A.PerfDevToolsEnabled = true;

        var OPTIONS = {
                componentCreation  : true,
                componentRendering : true,
                timelineMarks      : false,
                transactions       : true,
            },
            CMP_CREATE_MARK   = 'componentCreation',
            START_SUFIX       = 'Start',
            END_SUFIX         = 'End',
            CMP_CREATE_END    = CMP_CREATE_MARK + END_SUFIX,
            SAMPLING_INTERVAL = 0.025;


        $A.PerfDevTools = {
            init: function (cfg) {
                cfg || (cfg = {});
                this._initializeOptions(cfg);
                this._hooks = {};
                this.collector = {
                    componentCreation : [],
                    rendering: []
                };
                this._initializeHooks();
            },
            clearMarks: function (marks) {
                this._resetCollector(marks);
            },
            _initializeOptions: function (cfg) {
                this.opts = {
                    componentCreation  : cfg.componentCreation  || OPTIONS.componentCreation,
                    componentRendering : cfg.componentRendering || OPTIONS.componentRendering,
                    timelineMarks      : typeof cfg.timelineMarks === 'boolean' ? cfg.timelineMarks : OPTIONS.timelineMarks,
                    transactions       : cfg.transactions || OPTIONS.transactions
                };
            },
            _initializeHooks: function () {
                if (this.opts.componentCreation /* && $A.getContext().mode !== 'PROD'*/) {
                    this._initializeHooksComponentCreation();
                }
            },
            _createNode: function (name, mark, id) {
                return {
                    id  : id,
                    mark: mark,
                    name: name,
                    timestamp: window.performance.now(),
                };
            },
            _resetCollector: function (type) {
                if (type) {
                    this.collector[type] = [];
                    return;
                }

                for (var i in this.collector) {
                    this.collector[i] = [];
                }
            },
            _initializeHooksComponentCreation: function () {
                this._hookOverride("ComponentService.createComponentPriv", CMP_CREATE_MARK);
            },
            getComponentCreationProfile: function () {
                return this._generateCPUProfilerDataFromMarks(this.collector.componentCreation);
            },
            _hookOverride: function(key, mark) {
                $A.installOverride(key, function(){
                    var config = Array.prototype.shift.apply(arguments);
                    var args = Array.prototype.slice.apply(arguments);
                    var cmpConfig = arguments[0];
                    var callback = arguments[1];
                    var descriptor = $A.util.isString(cmpConfig) ? cmpConfig : (cmpConfig["componentDef"]["descriptor"] || cmpConfig["componentDef"]) + '';

                    var collector = this.collector[mark];
                    collector.push(this._createNode(descriptor, mark + START_SUFIX));

                    // When there is a callback, no return value is provided.
                    // The return value is passed to the callback in this case. 
                    if(typeof callback === "function") {
                        args[1] = (newCmp, status, message) => {
                            if(newCmp) {
                                var id = newCmp.getGlobalId && newCmp.getGlobalId() || "([ids])";
                                collector.push(this._createNode(descriptor, mark + END_SUFIX, id));
                            }
                            callback(newCmp, status, message);
                        };
                    }

                    var ret = config["fn"].apply(config["scope"], args);

                    if(ret !== undefined) { 
                        var id = ret.getGlobalId && ret.getGlobalId() || "([ids])";
                        collector.push(this._createNode(descriptor, mark + END_SUFIX, id));
                    }
                    return ret;

                }.bind(this), this);
            },
            _hookMethod: function (host, methodName, mark) {
                var self = this;
                var hook = host[methodName];
                var collector = this.collector[mark];

                this._hooks[methodName] = hook;
                host[methodName] = function (config) {
                    if (Array.isArray(config)) {
                        return hook.apply(this, arguments);
                    }

                    var descriptor = (config.componentDef.descriptor || config.componentDef) + '',
                        collector  = self.collector[mark];

                    // Add mark
                    collector.push(self._createNode(descriptor, mark + START_SUFIX));

                    // Hook!
                    var result = hook.apply(this, arguments);
                    var id = result.getGlobalId && result.getGlobalId() || '([ids])';

                    // End mark
                    collector.push(self._createNode(descriptor, mark + END_SUFIX, id));
                    return result;
                };
            },
            _generateCPUProfilerDataFromMarks: function (marks) {
                if(!marks || !marks.length) { return {}; }

                //global stuff for the id
                var id = 0;
                function nextId () {return ++id;}
                function logTree(stack, mark) {
                    // UNCOMMENT THIS FOR DEBUGGING PURPOSES:
                    // var d = '||| ';
                    // console.log(Array.apply(0, Array(stack)).map(function(){return d;}).join(''), mark);
                }

                function hashCode(name) {
                    var hash = 0, i, chr, len;
                    if (name.length == 0) return hash;
                    for (i = 0, len = name.length; i < len; i++) {
                        chr   = name.charCodeAt(i);
                        hash  = ((hash << 5) - hash) + chr;
                        hash |= 0; // Convert to 32bit integer
                    }
                    return Math.abs(hash);
                }

                function generateNode (name, options) {
                    options || (options = {});
                    return  {
                        functionName: name || ("Random." + Math.random()),
                        scriptId: "3",
                        url: options.details || "",
                        lineNumber: 0,
                        columnNumber: 0,
                        hitCount: options.hit || 0,
                        callUID: hashCode(name),
                        children: [],
                        deoptReason: "",
                        id: nextId()
                    };
                }

                var endText    = CMP_CREATE_END,
                    startTime  = marks[0].timestamp, // Get from first and last mark
                    endTime    = marks[marks.length - 1].timestamp,
                    markLength = marks.length,
                    duration   = endTime - startTime,
                    sampling   = SAMPLING_INTERVAL,
                    root       = generateNode("(root)"),
                    idle       = generateNode("(idle)"),
                    current    = generateNode(marks[0].name),
                    stack      = [current, root];

                current._startTime = marks[0].timestamp;

                function generateTimestamps(startTime, endTime) {
                    var diff  = endTime - startTime,
                        ticks = Math.round(diff / sampling), // every N miliseconds
                        time  = startTime,
                        ts    = [time];

                    for (var i = 1; i < ticks; i++) {
                        time += sampling;
                        ts.push(time);
                    }
                    return ts;
                }

                function generateSamples (root, size, idle) {
                    var samples = new Array(size).join(","+idle.id).split(idle.id);
                        samples[0] = idle.id;
                    var currentIndex = 0;
                    var idleHits = 0;


                    function calculateTimesForNode(node) {
                        if (node._idleHits) {
                            currentIndex += node._idleHits;
                            idleHits += node._idleHits;
                        }

                        for (var i = 0; i < node.hitCount; i++) {
                            samples[currentIndex + i] = node.id;
                        }
                        currentIndex += node.hitCount;

                        for (var j = 0; j < node.children.length; j++) {
                            calculateTimesForNode(node.children[j]);
                        }

                    }
                    calculateTimesForNode(root, root.id);
                    idle.hitCount = Math.max(0, size - currentIndex + idleHits); //update idle with remaining hits
                    return samples;
                }

                logTree(stack.length - 1, 'open: ' + marks[0].name);
                for (var i = 1; i < markLength; i++) {
                    var tmp = marks[i];
                    if (stack[0].functionName === tmp.name && tmp.mark === endText) {
                        var tmpNode = stack.shift();
                        tmpNode._endTime = tmp.timestamp;
                        tmpNode._totalTime = tmpNode._endTime - tmpNode._startTime;
                        tmpNode._childrenTime = tmpNode.children.reduce(function (p, c) {return p + c._totalTime;}, 0);
                        tmpNode._selfTime = tmpNode._totalTime - tmpNode._childrenTime;
                        tmpNode.hitCount = Math.floor(tmpNode._selfTime / sampling);
                        tmpNode._cmpId = tmp.id;
                        tmpNode._childComponentCount += tmpNode.children.length;

                        //push into the parent
                        stack[0].children.push(tmpNode);
                        stack[0]._childComponentCount += tmpNode._childComponentCount;
                        logTree(stack.length, 'close: ' + tmp.name + ' selfTime: ' + tmpNode._selfTime.toFixed(4) + '| totalTime: ' + tmpNode._totalTime.toFixed(4));
                    } else {

                        current = generateNode(tmp.name);
                        current._startTime = tmp.timestamp;
                        current._childComponentCount = 0;
                        if (stack.length === 1 && ((markLength - i) > 1)) {
                            current._idleHits = Math.floor((tmp.timestamp - marks[i - 1].timestamp) / sampling);
                        }

                        stack.unshift(current);
                        logTree(stack.length - 1, 'open: ' + tmp.name);
                    }
                }
                root.children.push(idle);
                var timestamp = generateTimestamps(startTime, endTime);
                var samples = generateSamples(root, timestamp.length, idle);

                return {
                    head: root,
                    startTime: startTime / 1000,
                    endTime : endTime / 1000,
                    timestamp: timestamp,
                    samples : samples,
                };
            }
        };
    };

