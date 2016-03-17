({
    setUp : function(component) {
        // must match AuraStorage.KEY_DELIMITER
        component.DELIMITER = ":";

        var completed = false;
        $A.storageService.getStorage("cmpStorage").clear()
            .then(
                function() { completed = true; },
                function(err) { $A.test.fail("Test setUp() failed to clear storage: " + err);
            });

        $A.test.addWaitFor(true, function() { return completed; });
    },

    testStorageKeyVersionString: {
        attributes : {
            "version" : "version"
        },
        test: function(cmp) {
            var completed = false;

            var key = "key";
            var expected = "value";
            var version = cmp.get("v.version");

            var storage = $A.storageService.getStorage("cmpStorage");
            storage.put(key, expected).then(function() {
                return storage.adapter.getItem(version + cmp.DELIMITER + key);
            })
            .then(function(item) {
                $A.test.assertEquals(expected, item["value"], "Storage with prefixed key should return correct value");
            })
            .then(function() {
                return storage.getAll();
            })
            .then(function(items) {
                $A.test.assertEquals(1, items.length, "Storage should only have one item");
                $A.test.assertEquals(key, items[0]["key"], "Key should not have prefix when returned to user");
                $A.test.assertEquals(expected, items[0]["value"], "Item with prefixed key should correct value");

                completed = true;
            })
            ["catch"](function(error) { $A.test.fail(error.toString()); });

            $A.test.addWaitFor(true, function() { return completed; });
        }
    },

    testSettingVersion: {
        attributes: {
            "version": "1"
        },
        test: function (cmp) {
            var storage = $A.storageService.getStorage("cmpStorage");
            $A.test.assertEquals("1", storage.getVersion(), "Declaratively set storage version not respected");
            storage.setVersion("2");
            $A.test.assertEquals("2", storage.getVersion(), "Imperatively set storage version not respected");
        }
    },

    testSettingGlobalVersion: {
        attributes: {
            "version": "setBeforeGlobal"
        },
        test: [
            function globalStorageVersion(cmp) {
                $A.storageService.setVersion("100");
                $A.test.assertEquals("100", $A.storageService.getVersion(), "Storage Service version not set.");
            }, function existingStorageVersion(cmp) {
                var storage = $A.storageService.getStorage("cmpStorage");
                $A.test.assertEquals("setBeforeGlobal", storage.getVersion(), "Previously created store should not have version");
            }, function newStorage(cmp) {
                var storage = $A.storageService.initStorage("testSettingGlobalVersion");
                $A.test.assertEquals("100", storage.getVersion(), "Newly created storage should inherit default version.");
            }
        ]
    },

    testEmptyVersionGetsGlobalVersion: {
        test: [
           function verifyVersionDefault(cmp) {
               var expected = "globalVersion"; // defined in versionTestTemplate.cmp
               var storage = $A.storageService.getStorage("templateStorageDefaultVersion");  // defined in versionTemplate.cmp
               $A.test.assertEquals(expected, storage.getVersion(), "<auraStorage:init/> component with default version did not inherit global value");
           },
           function verifyVersionEmptyString(cmp) {
               var expected = "globalVersion"; // defined in versionTestTemplate.cmp
               var storage = $A.storageService.getStorage("templateStorageEmptyVersion");  // defined in versionTemplate.cmp
               $A.test.assertEquals(expected, storage.getVersion(), "<auraStorage:init/> component with empty version did not inherit global value");
           }
       ]
    },

    testGetAllOnlyReturnsCurrentVersionWhenSwitchingBetweenVersions: {
        test: [function(cmp) {
            var completed = false;
            var storage = $A.storageService.initStorage("getAllIsolation", false, false, 1024);
            storage.setVersion("versionA");
            storage.put("keyA","valueA")
            .then(function() {
                storage.setVersion("versionB");
                return storage.put("keyB","valueB");
            })
            .then(function() {
                completed = true;
            })
            ["catch"](function(error) { $A.test.fail(error.toString()); });

            $A.test.addWaitFor(true, function(){ return completed; });
        }, function(cmp) {
            var storage = $A.storageService.getStorage("getAllIsolation");
            storage.getAll()
            .then(function(items) {
                $A.test.assertEquals(1, items.length, "Unexpected number of items returned from storage.getAll()");
                $A.test.assertEquals("valueB", items[0].value, "Unexpected value returned from storage");
            })
            ["catch"](function(error) { $A.test.fail(error.toString()); });
        }]
    },

    testGetAllOnlyReturnsCurrentVersionWhenSwitchingToNoVersion: {
        test: [function(cmp) {
            var completed = false;
            var storage = $A.storageService.initStorage("getAllIsolation", false, false, 1024);
            storage.setVersion("versionA");
            storage.put("keyA","valueA")
            .then(function() {
                storage.setVersion("");
                return storage.put("keyB","valueB");
            })
            .then(function() {
                completed = true;
            })
            ["catch"](function(error) { $A.test.fail(error.toString()); });

            $A.test.addWaitFor(true, function(){ return completed; });
        }, function(cmp) {
            var storage = $A.storageService.getStorage("getAllIsolation");
            storage.getAll()
            .then(function(items) {
                $A.test.assertEquals(1, items.length, "Unexpected number of items returned from storage.getAll()");
                $A.test.assertEquals("valueB", items[0].value, "Unexpected value returned from storage");
            })
            ["catch"](function(error) { $A.test.fail(error.toString()); });
        }]
    },

    testGetAllOnlyReturnsCurrentVersionWhenSwitchingFromNoVersion: {
        test: [function(cmp) {
            var completed = false;
            var storage = $A.storageService.initStorage("getAllIsolation", false, false, 1024);
            storage.setVersion("");
            storage.put("keyA","valueA")
            .then(function() {
                storage.setVersion("versionB");
                return storage.put("keyB","valueB");
            })
            .then(function() {
                completed = true;
            })
            ["catch"](function(error) { $A.test.fail(error.toString()); });

            $A.test.addWaitFor(true, function(){ return completed; });
        }, function(cmp) {
            var storage = $A.storageService.getStorage("getAllIsolation");
            storage.getAll()
            .then(function(items) {
                $A.test.assertEquals(1, items.length, "Unexpected number of items returned from storage.getAll()");
                $A.test.assertEquals("valueB", items[0].value, "Unexpected value returned from storage");
            })
            ["catch"](function(error) { $A.test.fail(error.toString()); });
        }]
    }
})
